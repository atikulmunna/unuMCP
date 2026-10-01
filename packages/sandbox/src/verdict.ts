import { parseTestSummary, type TestSummary } from "./parse";
import type { SandboxResult } from "./runSandbox";

export interface RunVerdict {
  summary: TestSummary;
  /** Tests actually ran, at least one passed, and none failed. */
  passed: boolean;
  /**
   * Preparation failed, or the test phase timed out or ran out of memory: an
   * infrastructure error, not a code defect (so it never triggers repair).
   */
  infraFailed: boolean;
}

/**
 * Classify a two-phase sandbox run (the single rule shared by the test stage and
 * the repair loop). A clean exit alone is not a pass: at least one test must be
 * reported passing, so a harness that runs nothing (code that calls
 * `process.exit(0)` on import, or a test script reduced to `exit 0`) can never
 * turn a project green. Pure, so it is unit-tested without Docker.
 */
/**
 * The test phase ran out of memory: V8's heap limit (an abort, exit 134, with
 * this message) or the container's cgroup limit (the kernel kills it, exit
 * 137). A resource ceiling, not a defect repair could fix.
 */
function outOfMemory(test: SandboxResult["test"]): boolean {
  return test.exitCode === 137 || /JavaScript heap out of memory/.test(test.log);
}

export function evaluateRun(result: SandboxResult): RunVerdict {
  const summary = parseTestSummary(result.test.log);
  const infraFailed = !result.install.ok || result.test.timedOut || outOfMemory(result.test);
  const passed = !infraFailed && result.test.ok && summary.failed === 0 && summary.passed > 0;
  return { summary, passed, infraFailed };
}
