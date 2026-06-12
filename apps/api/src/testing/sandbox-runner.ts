import { runSandbox, type SandboxResult } from "@unumcp/sandbox";

/**
 * Abstraction over the two-phase Docker sandbox so the orchestration can be
 * tested with a fake (no Docker) while production uses the real runner.
 */
export interface SandboxRunner {
  run(projectDir: string): Promise<SandboxResult>;
}

export const SANDBOX_RUNNER = "SANDBOX_RUNNER";

/** Default runner: delegates to the real `@unumcp/sandbox` two-phase runner. */
export const dockerSandboxRunner: SandboxRunner = {
  run: (projectDir: string) => runSandbox({ projectDir }),
};
