import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { computeMetrics, type PlatformMetrics, type RunRow } from "./metrics";

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregate observability metrics for the caller's own projects (P6-7, §25).
   * Scoped by `userId` so one user never sees another's counts; the pure
   * `computeMetrics` does the folding, this just gathers the rows.
   */
  async collect(userId: string): Promise<PlatformMetrics> {
    const ownedProject = { project: { userId } };

    const [projectsCreated, specsParsed, runs, tests, securityWarnings] = await Promise.all([
      this.prisma.project.count({ where: { userId } }),
      this.prisma.apiSpec.count({ where: { ...ownedProject, validationStatus: "valid" } }),
      this.prisma.generationRun.findMany({
        where: ownedProject,
        select: {
          status: true,
          startedAt: true,
          completedAt: true,
          repairAttempts: true,
          inputTokens: true,
          outputTokens: true,
          estimatedCostUsd: true,
        },
      }),
      this.prisma.testResult.findMany({
        where: { generationRun: ownedProject },
        select: { status: true },
      }),
      this.prisma.auditEvent.count({
        where: { ...ownedProject, eventType: "security_scan_failed" },
      }),
    ]);

    const runRows: RunRow[] = runs.map((r) => ({
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      repairAttempts: r.repairAttempts,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      // Prisma returns Decimal; fold to a plain number for the pure aggregator.
      estimatedCostUsd: r.estimatedCostUsd == null ? null : Number(r.estimatedCostUsd),
    }));

    return computeMetrics({ projectsCreated, specsParsed, runs: runRows, tests, securityWarnings });
  }
}
