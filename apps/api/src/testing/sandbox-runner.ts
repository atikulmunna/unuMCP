import { runSandbox, type SandboxPhase, type SandboxResult } from "@unumcp/sandbox";
import { createLimiter } from "../common/concurrency";

/** Live-log + cancellation hooks threaded through to the runner (P4-8). */
export interface SandboxRunOptions {
  onLog?: (phase: SandboxPhase, chunk: string) => void;
  signal?: AbortSignal;
}

/**
 * Abstraction over the Docker sandbox so the orchestration can be tested with a
 * fake (no Docker) while production uses the real runner.
 */
export interface SandboxRunner {
  run(projectDir: string, options?: SandboxRunOptions): Promise<SandboxResult>;
}

export const SANDBOX_RUNNER = "SANDBOX_RUNNER";

/**
 * How many sandbox runs may execute at once across the whole process (test
 * stage and repair reruns alike). Default 1: each run is a container with up to
 * a CPU and 512 MB, and the demo box has 2 GB.
 */
export function sandboxConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SANDBOX_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

const CANCELLED_WHILE_QUEUED: SandboxResult = {
  install: { ok: false, exitCode: null, log: "Cancelled while waiting for a sandbox slot.", timedOut: false },
  test: { ok: false, exitCode: null, log: "skipped (cancelled)", timedOut: false },
};

/**
 * Cap concurrent runs of `runner`: extra runs queue (FIFO) and say so in their
 * live log, and a run cancelled while queued never starts.
 */
export function withConcurrencyLimit(runner: SandboxRunner, limit: number): SandboxRunner {
  const limiter = createLimiter(limit);
  return {
    async run(projectDir, options) {
      if (limiter.saturated) options?.onLog?.("install", "Waiting for a free sandbox slot...\n");
      const release = await limiter.acquire(options?.signal);
      if (!release) return CANCELLED_WHILE_QUEUED;
      try {
        return await runner.run(projectDir, options);
      } finally {
        release();
      }
    },
  };
}

/** Default runner: the real `@unumcp/sandbox` runner behind the process-wide cap. */
export const dockerSandboxRunner: SandboxRunner = withConcurrencyLimit(
  { run: (projectDir, options) => runSandbox({ projectDir, ...options }) },
  sandboxConcurrencyFromEnv(),
);
