import { spawn } from "node:child_process";
import {
  buildInstallArgs,
  buildTestArgs,
  DEFAULT_IMAGE,
  DEFAULT_LIMITS,
  type SandboxLimits,
} from "./args";

export type SandboxPhase = "install" | "test";

export interface SandboxOptions {
  /** Host path to the generated project. */
  projectDir: string;
  image?: string;
  limits?: SandboxLimits;
  installTimeoutMs?: number;
  testTimeoutMs?: number;
  /** Cap on captured log bytes per phase, to bound memory on runaway output. */
  maxLogBytes?: number;
  /** Streamed output, chunk by chunk, as each phase runs (P4-8 live logs). */
  onLog?: (phase: SandboxPhase, chunk: string) => void;
  /** Abort the run (user cancel) — kills the active phase's container process. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_LOG_BYTES = 256 * 1024;

export interface PhaseResult {
  ok: boolean;
  exitCode: number | null;
  log: string;
  timedOut: boolean;
}

export interface SandboxResult {
  install: PhaseResult;
  test: PhaseResult;
}

function runDocker(
  args: string[],
  timeoutMs: number,
  maxLogBytes: number,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<PhaseResult> {
  return new Promise((resolve) => {
    // Already cancelled before we even start — don't spawn.
    if (signal?.aborted) {
      resolve({ ok: false, exitCode: null, log: "", timedOut: false });
      return;
    }
    const child = spawn("docker", args, { windowsHide: true });
    let log = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    // Stop appending once capped so runaway output can't exhaust memory, but
    // still stream every chunk to the live-log callback (it does its own cap).
    const append = (d: Buffer) => {
      const s = d.toString();
      if (log.length < maxLogBytes) log += s;
      onChunk?.(s);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const finish = (result: PhaseResult) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.on("error", (err) => finish({ ok: false, exitCode: null, log: log + String(err), timedOut }));
    child.on("close", (code) => finish({ ok: code === 0 && !timedOut, exitCode: code, log, timedOut }));
  });
}

/**
 * Run the two-phase sandbox over a generated project: install (network on,
 * mirror-restricted in prod) then test (network off, resource-limited).
 * The container is destroyed after each phase (`--rm`).
 */
export async function runSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const image = options.image ?? DEFAULT_IMAGE;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const { onLog, signal } = options;

  const install = await runDocker(
    buildInstallArgs(image, options.projectDir),
    options.installTimeoutMs ?? 180_000,
    maxLogBytes,
    onLog && ((chunk) => onLog("install", chunk)),
    signal,
  );
  if (!install.ok) {
    return {
      install,
      test: { ok: false, exitCode: null, log: "skipped (install failed)", timedOut: false },
    };
  }

  const test = await runDocker(
    buildTestArgs(image, options.projectDir, limits),
    options.testTimeoutMs ?? 120_000,
    maxLogBytes,
    onLog && ((chunk) => onLog("test", chunk)),
    signal,
  );
  return { install, test };
}
