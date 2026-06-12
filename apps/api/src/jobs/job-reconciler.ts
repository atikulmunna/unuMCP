import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ProjectStatus } from "@unumcp/db";
import { PrismaService } from "../prisma/prisma.service";

/** A run still `running` after this long is considered orphaned (no live worker). */
const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Crash recovery (P6-6, NFR-006 "mark failed jobs"). A `GenerationRun` left in
 * `running` after a process restart has no live worker driving it — it was
 * orphaned by the crash. On boot we mark such runs failed (and their project a
 * failure state) so the pipeline isn't stuck forever and the user can retry.
 *
 * Only runs whose `startedAt` is older than `STALE_AFTER_MS` are touched, so a
 * genuinely in-flight run (seconds old, e.g. during a rolling restart or another
 * instance sharing the DB) is never killed — only ones that have clearly hung.
 */
@Injectable()
export class JobReconciler implements OnApplicationBootstrap {
  private readonly logger = new Logger("JobReconciler");

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  /** Fail every stale orphaned `running` run; returns how many were recovered. */
  async reconcile(staleAfterMs: number = STALE_AFTER_MS): Promise<number> {
    const orphaned = await this.prisma.generationRun.findMany({
      where: { status: "running", startedAt: { lt: new Date(Date.now() - staleAfterMs) } },
      select: { id: true, projectId: true },
    });
    if (orphaned.length === 0) return 0;

    for (const run of orphaned) {
      // updateMany (not update) so a concurrently-deleted run/project yields a
      // 0-row no-op instead of a P2025 throw — reconcile must be idempotent and
      // safe to run from multiple instances sharing the DB.
      await this.prisma.$transaction([
        this.prisma.generationRun.updateMany({
          where: { id: run.id, status: "running" },
          data: {
            status: "failed",
            completedAt: new Date(),
            errorMessage: "Recovered after a restart; the generation job did not finish.",
          },
        }),
        this.prisma.project.updateMany({
          where: { id: run.projectId },
          data: { status: ProjectStatus.GENERATION_FAILED },
        }),
      ]);
    }
    this.logger.warn(`Reconciled ${orphaned.length} orphaned generation run(s) after restart.`);
    return orphaned.length;
  }
}
