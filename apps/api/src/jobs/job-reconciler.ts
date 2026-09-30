import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ProjectStatus } from "@unumcp/db";
import { PrismaService } from "../prisma/prisma.service";

/** A run still `running` after this long is considered orphaned (no live worker). */
const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * A project still mid-test or mid-repair this long after its last update is
 * orphaned. Longer than the generation window: a legitimate repair loop is
 * several LLM calls plus sandbox reruns, possibly queued behind other runs.
 */
const STALE_STAGE_AFTER_MS = 15 * 60 * 1000;

/**
 * In-flight stages a crash can strand, and the state each settles on: a test
 * run that never finished is an infrastructure failure (safe to retry), and an
 * interrupted repair falls back to the failing result it started from (only a
 * passing repair is ever saved, so the stored code is still the generated one).
 */
const STRANDED_STAGES = {
  [ProjectStatus.TEST_RUNNING]: { next: ProjectStatus.SANDBOX_FAILED, what: "sandbox test run" },
  [ProjectStatus.REPAIRING_FAILED_CODE]: { next: ProjectStatus.TESTS_FAILED, what: "repair loop" },
} as const;

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
    await this.reconcileStages();
  }

  /**
   * Settle every project stranded mid-test or mid-repair (stale past
   * `staleAfterMs`) on a terminal state the user can act on, with an audit
   * event explaining why. Returns how many were recovered.
   */
  async reconcileStages(staleAfterMs: number = STALE_STAGE_AFTER_MS): Promise<number> {
    const stranded = await this.prisma.project.findMany({
      where: {
        status: { in: [ProjectStatus.TEST_RUNNING, ProjectStatus.REPAIRING_FAILED_CODE] },
        updatedAt: { lt: new Date(Date.now() - staleAfterMs) },
      },
      select: { id: true, status: true },
    });

    let recovered = 0;
    for (const project of stranded) {
      const stage = STRANDED_STAGES[project.status as keyof typeof STRANDED_STAGES];
      await this.prisma.$transaction(async (tx) => {
        // Conditional on the status we read, so a project another instance just
        // moved on (or already recovered) is left alone.
        const { count } = await tx.project.updateMany({
          where: { id: project.id, status: project.status },
          data: { status: stage.next },
        });
        if (count === 0) return;
        recovered++;
        await tx.auditEvent.create({
          data: {
            projectId: project.id,
            eventType: "run_recovered",
            actor: "system",
            summary: `Recovered after a restart: the ${stage.what} did not finish, so the project is now ${stage.next}.`,
          },
        });
      });
    }
    if (recovered > 0) {
      this.logger.warn(`Recovered ${recovered} project(s) stranded mid-test or mid-repair after restart.`);
    }
    return recovered;
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
