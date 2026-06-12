import { spawn } from "node:child_process";
import {
  buildInstallArgs,
  buildTestArgs,
  DEFAULT_IMAGE,
  DEFAULT_LIMITS,
  type SandboxLimits,
} from "./args";

export interface SandboxOptions {
  /** Host path to the generated project. */
  projectDir: string;
  image?: string;
  limits?: SandboxLimits;
  installTimeoutMs?: number;
  testTimeoutMs?: number;
  /** Cap on captured log bytes per phase, to bound memory on runaway output. */
  maxLogBytes?: number;
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

function runDocker(args: string[], timeoutMs: number, maxLogBytes: number): Promise<PhaseResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true });
    let log = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // Stop appending once capped so runaway output can't exhaust memory.
    const append = (d: Buffer) => {
      if (log.length < maxLogBytes) log += d.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, log: log + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, exitCode: code, log, timedOut });
    });
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

  const install = await runDocker(
    buildInstallArgs(image, options.projectDir),
    options.installTimeoutMs ?? 180_000,
    maxLogBytes,
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
  );
  return { install, test };
}
