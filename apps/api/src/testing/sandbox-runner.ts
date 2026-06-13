import { runSandbox, type SandboxPhase, type SandboxResult } from "@unumcp/sandbox";

/** Live-log + cancellation hooks threaded through to the runner (P4-8). */
export interface SandboxRunOptions {
  onLog?: (phase: SandboxPhase, chunk: string) => void;
  signal?: AbortSignal;
}

/**
 * Abstraction over the two-phase Docker sandbox so the orchestration can be
 * tested with a fake (no Docker) while production uses the real runner.
 */
export interface SandboxRunner {
  run(projectDir: string, options?: SandboxRunOptions): Promise<SandboxResult>;
}

export const SANDBOX_RUNNER = "SANDBOX_RUNNER";

/** Default runner: delegates to the real `@unumcp/sandbox` two-phase runner. */
export const dockerSandboxRunner: SandboxRunner = {
  run: (projectDir: string, options?: SandboxRunOptions) =>
    runSandbox({ projectDir, ...options }),
};
