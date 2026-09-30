import { parseTestSummary, type TestSummary } from "./parse";
import type { SandboxResult } from "./runSandbox";

export interface RunVerdict {
  summary: TestSummary;
  /** Tests actually ran, at least one passed, and none failed. */
  passed: boolean;
  /** Preparation failed or the test phase timed out: an infrastructure error, not a code defect. */
  infraFailed: boolean;
}

/**
 * Classify a two-phase sandbox run (the single rule shared by the test stage and
 * the repair loop). A clean exit alone is not a pass: at least one test must be
 * reported passing, so a harness that runs nothing (code that calls
 * `process.exit(0)` on import, or a test script reduced to `exit 0`) can never
 * turn a project green. Pure, so it is unit-tested without Docker.
 */
export function evaluateRun(result: SandboxResult): RunVerdict {
  const summary = parseTestSummary(result.test.log);
  const infraFailed = !result.install.ok || result.test.timedOut;
  const passed = !infraFailed && result.test.ok && summary.failed === 0 && summary.passed > 0;
  return { summary, passed, infraFailed };
}
