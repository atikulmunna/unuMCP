import type { GenerationStatus, TestStatus } from "@unumcp/db";

/**
 * Pure metrics aggregation (P6-7, §25). Kept free of Prisma so it is trivially
 * unit-testable: `MetricsService` fetches the rows, this folds them into the
 * numbers operators care about (success rate, test pass rate, generation time,
 * repair counts, token cost). Same shape/altitude as `computeWarnings`.
 */

export interface RunRow {
  status: GenerationStatus;
  startedAt: Date;
  completedAt: Date | null;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
}

export interface TestRow {
  status: TestStatus;
}

export interface MetricsInput {
  projectsCreated: number;
  /** ApiSpec rows that validated successfully (§25.1 "specs successfully parsed"). */
  specsParsed: number;
  runs: RunRow[];
  tests: TestRow[];
  /** Count of `security_scan_failed` audit events (§25.2 "security warnings"). */
  securityWarnings: number;
}

export interface PlatformMetrics {
  projectsCreated: number;
  specsParsed: number;
  serversGenerated: number;
  /** successful runs ÷ finished (non-running) runs, 0..1. */
  generationSuccessRate: number;
  /** passing test results ÷ all test results, 0..1. */
  testPassRate: number;
  avgGenerationTimeMs: number;
  repairAttemptsTotal: number;
  repairAttemptsAvg: number;
  failedSandboxRuns: number;
  securityWarnings: number;
  cost: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalEstimatedCostUsd: number;
  };
}

const SUCCESS: ReadonlySet<GenerationStatus> = new Set(["passed", "passed_with_warnings"]);

/** Ratio rounded to 4 dp; 0 when the denominator is empty (avoids NaN). */
function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export function computeMetrics(input: MetricsInput): PlatformMetrics {
  const { runs, tests } = input;

  const finishedRuns = runs.filter((r) => r.status !== "running");
  const serversGenerated = runs.filter((r) => SUCCESS.has(r.status)).length;

  const timed = runs.filter((r) => r.completedAt !== null);
  const totalTimeMs = timed.reduce(
    (sum, r) => sum + ((r.completedAt as Date).getTime() - r.startedAt.getTime()),
    0,
  );

  const passedTests = tests.filter((t) => t.status === "passed").length;
  const failedSandboxRuns = tests.filter((t) => t.status === "errored").length;

  const repairAttemptsTotal = runs.reduce((sum, r) => sum + r.repairAttempts, 0);

  const totalInputTokens = runs.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
  const totalOutputTokens = runs.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
  const totalEstimatedCostUsd =
    Math.round(runs.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0) * 10000) / 10000;

  return {
    projectsCreated: input.projectsCreated,
    specsParsed: input.specsParsed,
    serversGenerated,
    generationSuccessRate: ratio(serversGenerated, finishedRuns.length),
    testPassRate: ratio(passedTests, tests.length),
    avgGenerationTimeMs: timed.length === 0 ? 0 : Math.round(totalTimeMs / timed.length),
    repairAttemptsTotal,
    repairAttemptsAvg: runs.length === 0 ? 0 : Math.round((repairAttemptsTotal / runs.length) * 100) / 100,
    failedSandboxRuns,
    securityWarnings: input.securityWarnings,
    cost: { totalInputTokens, totalOutputTokens, totalEstimatedCostUsd },
  };
}
