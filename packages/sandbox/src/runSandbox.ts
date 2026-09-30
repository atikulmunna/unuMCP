import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTestArgs, CONTAINER_NAME_PREFIX, DEFAULT_LIMITS, type SandboxLimits } from "./args";
import { ensureSandboxImage, missingDependencies, SANDBOX_IMAGE } from "./image";

/** `install` is the prepare step (kept under its historical name for API compatibility). */
export type SandboxPhase = "install" | "test";

export interface SandboxOptions {
  /** Host path to the generated project. */
  projectDir: string;
  /** Prebuilt image to run. Defaults to {@link SANDBOX_IMAGE}, built on first use. */
  image?: string;
  limits?: SandboxLimits;
  testTimeoutMs?: number;
  /** Cap on captured log bytes per phase, to bound memory on runaway output. */
  maxLogBytes?: number;
  /** Streamed output, chunk by chunk, as each phase runs (P4-8 live logs). */
  onLog?: (phase: SandboxPhase, chunk: string) => void;
  /** Abort the run (user cancel): force-removes the active phase's container. */
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
  /**
   * Preparation, under its historical name: the sandbox image exists and
   * provides every dependency the project declares. No container runs and the
   * project gets no network; a failure here is an infrastructure error.
   */
  install: PhaseResult;
  test: PhaseResult;
}

/**
 * Force-remove a container by name, killing it first if it is still running.
 * Errors are ignored: the container may already be gone (or never started).
 */
function removeContainer(name: string): Promise<void> {
  return new Promise((resolve) => {
    const rm = spawn("docker", ["rm", "--force", name], { windowsHide: true, stdio: "ignore" });
    rm.on("error", () => resolve());
    rm.on("close", () => resolve());
  });
}

function runDocker(
  args: string[],
  containerName: string,
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
    // SIGKILL on the `docker` CLI only detaches the client; the container keeps
    // running. Remove the container through the daemon, then make sure the CLI
    // exits too (it normally does on its own once its container is gone).
    let removal: Promise<void> | null = null;
    const stop = () => {
      removal ??= removeContainer(containerName).then(() => {
        child.kill("SIGKILL");
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = stop;
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
      // After a timeout/cancel, settle only once the container is really gone, so
      // callers can safely delete the mounted project dir.
      if (removal) void removal.then(() => resolve(result));
      else resolve(result);
    };
    child.on("error", (err) => finish({ ok: false, exitCode: null, log: log + String(err), timedOut }));
    child.on("close", (code) => finish({ ok: code === 0 && !timedOut, exitCode: code, log, timedOut }));
  });
}

/**
 * Prepare a run without starting any container: the sandbox image exists
 * (built on first use from its trusted in-code manifest), it provides exactly
 * the dependencies the project declares, and the project dir is readable by the
 * sandbox's unprivileged user.
 */
async function prepare(
  projectDir: string,
  image: string,
  buildIfMissing: boolean,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<PhaseResult> {
  const fail = (log: string): PhaseResult => ({ ok: false, exitCode: null, log, timedOut: false });
  if (signal?.aborted) return fail("");

  if (buildIfMissing) {
    const ensured = await ensureSandboxImage(onChunk);
    if (!ensured.ok) return fail(`Could not build the sandbox image ${image}.\n${ensured.log.slice(-4_000)}`);
  }

  let manifest: string;
  try {
    manifest = await readFile(join(projectDir, "package.json"), "utf8");
  } catch {
    return fail("The project has no package.json.");
  }
  const missing = missingDependencies(manifest);
  if (missing.length > 0) {
    return fail(
      `The sandbox image does not provide: ${missing.join(", ")}. The project's dependencies ` +
        "must match the image's (codegen's template); nothing is installed at test time.",
    );
  }

  // mkdtemp creates 0700 dirs; the sandbox's unprivileged user must be able to read the mount.
  await chmod(projectDir, 0o755);
  const log = `Sandbox image ${image} ready: dependencies preinstalled, nothing downloaded.\n`;
  onChunk?.(log);
  return { ok: true, exitCode: 0, log, timedOut: false };
}

/**
 * Run a generated project's tests in the sandbox: prepare (image + dependency
 * check, no container, no network), then one locked-down, network-less test
 * container that is destroyed afterwards (`--rm`).
 */
export async function runSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const image = options.image ?? SANDBOX_IMAGE;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const { onLog, signal } = options;
  const testName = `${CONTAINER_NAME_PREFIX}${randomUUID()}-test`;

  const install = await prepare(
    options.projectDir,
    image,
    options.image === undefined,
    onLog && ((chunk) => onLog("install", chunk)),
    signal,
  );
  if (!install.ok) {
    return {
      install,
      test: { ok: false, exitCode: null, log: "skipped (sandbox not ready)", timedOut: false },
    };
  }

  const test = await runDocker(
    buildTestArgs(image, options.projectDir, testName, limits),
    testName,
    options.testTimeoutMs ?? 120_000,
    maxLogBytes,
    onLog && ((chunk) => onLog("test", chunk)),
    signal,
  );
  return { install, test };
}
