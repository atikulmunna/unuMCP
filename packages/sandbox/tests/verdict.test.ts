import { describe, expect, it } from "vitest";
import type { SandboxResult } from "../src/runSandbox";
import { evaluateRun } from "../src/verdict";

function run(testLog: string, testOk = true, overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    install: { ok: true, exitCode: 0, log: "added 50 packages", timedOut: false },
    test: { ok: testOk, exitCode: testOk ? 0 : 1, log: testLog, timedOut: false },
    ...overrides,
  };
}

describe("evaluateRun", () => {
  it("passes a clean run whose tests all passed", () => {
    expect(evaluateRun(run(" Tests  4 passed (4)\n"))).toEqual({
      summary: { passed: 4, failed: 0, skipped: 0, total: 4 },
      passed: true,
      infraFailed: false,
    });
  });

  it("fails a run with a failing test", () => {
    const v = evaluateRun(run(" Tests  1 failed | 3 passed (4)\n", false));
    expect(v.passed).toBe(false);
    expect(v.infraFailed).toBe(false);
  });

  it("does NOT pass a clean exit that reported no tests (harness bypass)", () => {
    // e.g. the test script rewritten to `exit 0`, or code calling process.exit(0) on import.
    const v = evaluateRun(run(""));
    expect(v.summary.total).toBe(0);
    expect(v.passed).toBe(false);
    expect(v.infraFailed).toBe(false);
  });

  it("does NOT pass a clean run where every test was skipped", () => {
    expect(evaluateRun(run(" Tests  3 skipped (3)\n")).passed).toBe(false);
  });

  it("treats an install failure as infrastructure, not a code failure", () => {
    const v = evaluateRun(
      run("skipped (install failed)", false, {
        install: { ok: false, exitCode: 1, log: "npm ERR!", timedOut: false },
      }),
    );
    expect(v).toMatchObject({ passed: false, infraFailed: true });
  });

  it("treats running out of memory as infrastructure, not a code failure for repair", () => {
    const heap = evaluateRun(
      run("FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory", false),
    );
    expect(heap).toMatchObject({ passed: false, infraFailed: true });
    const killed = evaluateRun(
      run("", false, { test: { ok: false, exitCode: 137, log: "", timedOut: false } }),
    );
    expect(killed).toMatchObject({ passed: false, infraFailed: true });
  });

  it("treats a test-phase timeout as infrastructure, even with a passing summary", () => {
    const v = evaluateRun(
      run(" Tests  4 passed (4)\n", true, {
        test: { ok: false, exitCode: null, log: " Tests  4 passed (4)\n", timedOut: true },
      }),
    );
    expect(v).toMatchObject({ passed: false, infraFailed: true });
  });
});
