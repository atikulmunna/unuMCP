import { describe, expect, it } from "vitest";
import { computeMetrics, type RunRow } from "../src/metrics/metrics";

function run(partial: Partial<RunRow>): RunRow {
  return {
    status: "passed",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:00:10Z"),
    repairAttempts: 0,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    ...partial,
  };
}

describe("computeMetrics (P6-7, §25)", () => {
  it("returns zeroed metrics with no data (no NaN/divide-by-zero)", () => {
    const m = computeMetrics({
      projectsCreated: 0,
      specsParsed: 0,
      runs: [],
      tests: [],
      securityWarnings: 0,
    });
    expect(m.generationSuccessRate).toBe(0);
    expect(m.testPassRate).toBe(0);
    expect(m.avgGenerationTimeMs).toBe(0);
    expect(m.repairAttemptsAvg).toBe(0);
    expect(m.cost.totalEstimatedCostUsd).toBe(0);
  });

  it("counts generated servers and computes the success rate over finished runs", () => {
    const m = computeMetrics({
      projectsCreated: 5,
      specsParsed: 4,
      runs: [
        run({ status: "passed" }),
        run({ status: "passed_with_warnings" }),
        run({ status: "failed" }),
        run({ status: "running", completedAt: null }), // in-flight: excluded from the rate
      ],
      tests: [],
      securityWarnings: 2,
    });
    expect(m.projectsCreated).toBe(5);
    expect(m.specsParsed).toBe(4);
    expect(m.serversGenerated).toBe(2);
    // 2 successful out of 3 finished (the running one is excluded).
    expect(m.generationSuccessRate).toBe(0.6667);
    expect(m.securityWarnings).toBe(2);
  });

  it("averages generation time only over completed runs", () => {
    const m = computeMetrics({
      projectsCreated: 2,
      specsParsed: 2,
      runs: [
        run({
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: new Date("2026-01-01T00:00:10Z"), // 10s
        }),
        run({
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: new Date("2026-01-01T00:00:30Z"), // 30s
        }),
        run({ status: "running", completedAt: null }), // ignored
      ],
      tests: [],
      securityWarnings: 0,
    });
    expect(m.avgGenerationTimeMs).toBe(20000);
  });

  it("computes test pass rate and counts errored sandbox runs", () => {
    const m = computeMetrics({
      projectsCreated: 1,
      specsParsed: 1,
      runs: [],
      tests: [
        { status: "passed" },
        { status: "passed" },
        { status: "failed" },
        { status: "errored" },
      ],
      securityWarnings: 0,
    });
    expect(m.testPassRate).toBe(0.5);
    expect(m.failedSandboxRuns).toBe(1);
  });

  it("sums repair attempts and token cost across runs", () => {
    const m = computeMetrics({
      projectsCreated: 1,
      specsParsed: 1,
      runs: [
        run({ repairAttempts: 1, inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.12 }),
        run({ repairAttempts: 3, inputTokens: 2000, outputTokens: 700, estimatedCostUsd: 0.3456 }),
      ],
      tests: [],
      securityWarnings: 0,
    });
    expect(m.repairAttemptsTotal).toBe(4);
    expect(m.repairAttemptsAvg).toBe(2);
    expect(m.cost.totalInputTokens).toBe(3000);
    expect(m.cost.totalOutputTokens).toBe(1200);
    expect(m.cost.totalEstimatedCostUsd).toBe(0.4656);
  });
});
