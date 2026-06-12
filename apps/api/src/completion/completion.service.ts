import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma, ProjectStatus } from "@unumcp/db";
import type { DetectedAuth } from "@unumcp/openapi";
import { PrismaService } from "../prisma/prisma.service";
import { computeWarnings } from "./warnings";

// Test outcomes that are not eligible for completion.
const NOT_PASSED = "Tests must pass before the project can be completed.";

@Injectable()
export class CompletionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finalize a project whose tests passed (P5-7). Computes any non-blocking
   * warnings and lands the terminal state — `COMPLETED` when clean, or
   * `COMPLETED_WITH_WARNINGS` so the user can still download the partial output
   * (§26.4). Idempotent-ish: re-completing recomputes from current facts.
   */
  async complete(projectId: string, userId: string) {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    if (project.status !== ProjectStatus.TESTS_PASSED) {
      throw new BadRequestException(NOT_PASSED);
    }

    const run = await this.prisma.generationRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    const latestTest = run
      ? await this.prisma.testResult.findFirst({
          where: { generationRunId: run.id },
          orderBy: { createdAt: "desc" },
        })
      : null;

    const spec = await this.prisma.apiSpec.findFirst({
      where: { projectId, validationStatus: "valid" },
      orderBy: { createdAt: "desc" },
    });
    const auth = spec?.detectedAuth as DetectedAuth | null;

    const warnings = computeWarnings({
      authNeedsUserConfig: auth?.needsUserConfig ?? false,
      totalTestCount: latestTest?.totalTestCount ?? 0,
      failingTestCount: latestTest?.failingTestCount ?? 0,
    });

    const status =
      warnings.length > 0
        ? ProjectStatus.COMPLETED_WITH_WARNINGS
        : ProjectStatus.COMPLETED;

    await this.prisma.$transaction([
      this.prisma.project.update({ where: { id: projectId }, data: { status } }),
      ...(run
        ? [
            this.prisma.generationRun.update({
              where: { id: run.id },
              data: { status: warnings.length > 0 ? "passed_with_warnings" : "passed" },
            }),
          ]
        : []),
      this.prisma.auditEvent.create({
        data: {
          projectId,
          userId,
          eventType: "project_completed",
          actor: "user",
          summary:
            warnings.length > 0
              ? `Completed with ${warnings.length} warning(s)`
              : "Completed successfully",
          metadata: { warnings } as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    return { status, warnings };
  }
}
