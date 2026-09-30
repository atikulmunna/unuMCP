import type { TestResult } from "@unumcp/db";
import type { PrismaService } from "../prisma/prisma.service";

/** Suite of a regular test-stage run of the stored code. */
export const TEST_SUITE = "vitest";

/**
 * Suite of a repair rerun. A rerun tests a candidate fix that is saved only if
 * it passes, so a failed rerun describes code that was never stored.
 */
export const REPAIR_SUITE = "vitest-repair";

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
