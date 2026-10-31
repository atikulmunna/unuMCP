import { ProjectStatus, TestStatus, type GenerationStatus, type TestResult } from "@unumcp/db";
import type { PrismaService } from "../prisma/prisma.service";

/** Suite of a regular test-stage run of the stored code. */
export const TEST_SUITE = "vitest";

/**
 * Suite of a repair rerun. A rerun tests a candidate fix that is saved only if
 * it passes, so a failed rerun describes code that was never stored.
 */
export const REPAIR_SUITE = "vitest-repair";

/**
 * Where a sandbox run leaves the test result, the project, and the generation
 * run. An infrastructure failure is kept apart from a clean test failure, which
 * is the only kind the repair loop works on.
 */
export function statusesFor(verdict: { passed: boolean; infraFailed: boolean }): {
  test: TestStatus;
  project: ProjectStatus;
  run: GenerationStatus;
} {
  if (verdict.infraFailed) {
    return { test: TestStatus.errored, project: ProjectStatus.SANDBOX_FAILED, run: "failed" };
  }
  if (verdict.passed) {
    return { test: TestStatus.passed, project: ProjectStatus.TESTS_PASSED, run: "passed" };
  }
  return { test: TestStatus.failed, project: ProjectStatus.TESTS_FAILED, run: "failed" };
}

/**
 * The latest result that describes the code as currently stored: a regular
 * test-stage run, or a repair rerun that passed (the only kind that gets saved).
 * Warnings, completion, and downloads use this instead of the newest row.
 */
export function latestStoredCodeResult(
  prisma: PrismaService,
  generationRunId: string,
): Promise<TestResult | null> {
  return prisma.testResult.findFirst({
    where: { generationRunId, OR: [{ suite: { not: REPAIR_SUITE } }, { status: "passed" }] },
    orderBy: { createdAt: "desc" },
  });
}
