import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseTestSummary, truncateLog, type SandboxResult, type TestSummary } from "@unumcp/sandbox";
import { redactSecrets } from "@unumcp/security-scan";
import { unifiedDiff, type RepairFile } from "@unumcp/llm";
import {
  ArtifactType,
  ProjectStatus,
  RepairOutcome,
  TestStatus,
  type GeneratedArtifact,
  type GenerationStatus,
} from "@unumcp/db";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { LlmService } from "../llm/llm.service";
import { SANDBOX_RUNNER, type SandboxRunner } from "../testing/sandbox-runner";
import { repairConfigFromEnv, type RepairConfig } from "./repair.config";

export interface RepairSummary {
  repaired: boolean;
  attempts: number;
}

const FAILURE_SUMMARY_CAP = 4_000;
const DIFF_CAP = 20_000;

/**
 * Bounded self-repair loop (P4-5/P4-6, FR-026, §11.4). After a clean test
 * failure: read the failure → ask the LLM to fix the **implementation only** →
 * rerun the sandbox → repeat up to `maxAttempts`. Tests are frozen (only
 * `source_file` artifacts are editable, and the repair parser rejects any test
 * path). Every pass is persisted as a `RepairAttempt` (diff + failure + outcome)
 * so the user can inspect the history; on exhaustion the project stays
 * `TESTS_FAILED` — never a silent success.
 *
 * One pass is ~40s (LLM) + a full sandbox rerun, so this runs on the background
 * queue (P6-6), not in-request.
 */
@Injectable()
export class RepairService {
  private readonly logger = new Logger("RepairService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(SANDBOX_RUNNER) private readonly sandbox: SandboxRunner,
    private readonly llm: LlmService,
    private readonly config: RepairConfig = repairConfigFromEnv(),
  ) {}

  /** Repair only runs when the LLM is configured; otherwise it's a no-op. */
  get enabled(): boolean {
    return this.llm.enabled;
  }

  /**
   * Attempt to repair the latest failing run of a project. Safe to call when the
   * LLM is disabled or there is nothing to repair — returns a no-op summary.
   */
  async repairFailingRun(projectId: string): Promise<RepairSummary> {
    if (!this.enabled) return { repaired: false, attempts: 0 };

    const run = await this.prisma.generationRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    if (!run) return { repaired: false, attempts: 0 };

    const lastFailure = await this.prisma.testResult.findFirst({
      where: { generationRunId: run.id, status: TestStatus.failed },
      orderBy: { createdAt: "desc" },
    });
    if (!lastFailure) return { repaired: false, attempts: 0 };

    const artifacts = await this.prisma.generatedArtifact.findMany({
      where: { projectId, contentUrl: { not: null } },
    });
    // Only real source files are editable; README and tests stay frozen.
    const editable = artifacts.filter((a) => a.artifactType === ArtifactType.source_file);
    if (editable.length === 0) return { repaired: false, attempts: 0 };
    const byPath = new Map(editable.map((a) => [a.path, a]));

    const dir = await mkdtemp(join(tmpdir(), "unumcp-repair-"));
    try {
      // Materialize the whole project once; only changed files are overwritten between passes.
      for (const a of artifacts) {
        const dest = join(dir, a.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, await this.storage.read(a.contentUrl as string));
      }

      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.REPAIRING_FAILED_CODE },
      });

      let failureLog = lastFailure.logExcerpt ?? "";
      let attemptsMade = 0;
      let repaired = false;

      for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
        attemptsMade = attempt;
        const files: RepairFile[] = await Promise.all(
          editable.map(async (a) => ({
            path: a.path,
            content: await this.storage.read(a.contentUrl as string),
          })),
        );

        let changed: RepairFile[];
        try {
          const result = await this.llm.repair(
            {
              failureLog,
              files,
              maxTokens: this.config.maxTokens,
            },
            { projectId },
          );
          changed = result.files;
        } catch (err) {
          // LLM error or a rejected edit (e.g. it tried to touch a frozen test).
          this.logger.warn(
            `Repair attempt ${attempt} produced no usable fix (${err instanceof Error ? err.name : "error"}); stopping.`,
          );
          await this.recordAttempt(run.id, attempt, failureLog, "", RepairOutcome.failed);
          break;
        }

        // Diff against the pre-repair contents, then apply (temp dir + persisted artifact).
        const before = new Map(files.map((f) => [f.path, f.content]));
        const diff = changed
          .map((f) => unifiedDiff(before.get(f.path) ?? "", f.content, f.path))
          .filter((d) => d.length > 0)
          .join("\n\n");
        for (const f of changed) {
          const artifact = byPath.get(f.path);
          if (!artifact) continue; // repairCode already enforces the editable allowlist
          await writeFile(join(dir, f.path), f.content);
          await this.persistArtifact(artifact, f.content);
        }

        // Rerun the sandbox on the patched project.
        const startedAt = Date.now();
        const result = await this.sandbox.run(dir);
        const durationMs = Date.now() - startedAt;
        const { summary, passed, infraFailed, log } = classifyRun(result);

        const outcome = passed ? RepairOutcome.passed : RepairOutcome.failed;
        await this.recordAttempt(run.id, attempt, failureLog, diff, outcome);
        await this.recordRerun(run.id, projectId, summary, durationMs, log, passed, infraFailed);

        if (passed) {
          this.logger.log(`Repair succeeded for project ${projectId} after ${attempt} attempt(s).`);
          repaired = true;
          break;
        }
        failureLog = log;
      }

      if (!repaired) {
        // Exhausted, or stopped early before a rerun: never leave the project
        // mid-repair — settle on TESTS_FAILED (partial output, never silent success).
        await this.prisma.project.update({
          where: { id: projectId },
          data: { status: ProjectStatus.TESTS_FAILED },
        });
        this.logger.warn(
          `Repair did not pass after ${attemptsMade} attempt(s) for project ${projectId}; left TESTS_FAILED.`,
        );
      }
      return { repaired, attempts: attemptsMade };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Overwrite a stored artifact in place with the repaired content + new hash. */
  private async persistArtifact(artifact: GeneratedArtifact, content: string): Promise<void> {
    const contentHash = createHash("sha256").update(content).digest("hex");
    const contentUrl = await this.storage.save(artifact.contentUrl as string, content);
    await this.prisma.generatedArtifact.update({
      where: { id: artifact.id },
      data: { contentHash, contentUrl },
    });
  }

  /** Persist a `RepairAttempt` row and bump the run's attempt counter. */
  private async recordAttempt(
    runId: string,
    attemptNumber: number,
    failureLog: string,
    diff: string,
    outcome: RepairOutcome,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.repairAttempt.create({
        data: {
          generationRunId: runId,
          attemptNumber,
          failureSummary: cap(redactSecrets(failureLog), FAILURE_SUMMARY_CAP),
          diff: cap(diff, DIFF_CAP),
          outcome,
        },
      }),
      this.prisma.generationRun.update({
        where: { id: runId },
        data: { repairAttempts: attemptNumber },
      }),
    ]);
  }

  /** Record the rerun's `TestResult` and advance run + project state. */
  private async recordRerun(
    runId: string,
    projectId: string,
    summary: TestSummary,
    durationMs: number,
    logExcerpt: string,
    passed: boolean,
    infraFailed: boolean,
  ): Promise<void> {
    const status = infraFailed
      ? TestStatus.errored
      : passed
        ? TestStatus.passed
        : TestStatus.failed;
    const projectStatus = infraFailed
      ? ProjectStatus.SANDBOX_FAILED
      : passed
        ? ProjectStatus.TESTS_PASSED
        : ProjectStatus.TESTS_FAILED;
    const runStatus: GenerationStatus = passed ? "passed" : "failed";

    await this.prisma.$transaction([
      this.prisma.testResult.create({
        data: {
          generationRunId: runId,
          suite: "vitest",
          status,
          durationMs,
          failingTestCount: summary.failed,
          totalTestCount: summary.total,
          logExcerpt,
        },
      }),
      this.prisma.generationRun.update({
        where: { id: runId },
        data: { status: runStatus, completedAt: new Date() },
      }),
      this.prisma.project.update({ where: { id: projectId }, data: { status: projectStatus } }),
      this.prisma.auditEvent.create({
        data: {
          projectId,
          eventType: "repair_attempt",
          actor: "agent",
          summary: `Repair rerun: tests ${status} (${summary.passed}/${summary.total} passed)`,
        },
      }),
    ]);
  }
}

interface RunOutcome {
  summary: TestSummary;
  passed: boolean;
  infraFailed: boolean;
  log: string;
}

/** Classify a sandbox rerun the same way `TestingService` does (single source of truth in spirit). */
function classifyRun(result: SandboxResult): RunOutcome {
  const summary = parseTestSummary(result.test.log);
  const infraFailed = !result.install.ok || result.test.timedOut;
  const passed = result.test.ok && summary.failed === 0 && !infraFailed;
  const log = truncateLog(redactSecrets(infraFailed ? result.install.log : result.test.log));
  return { summary, passed, infraFailed, log };
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}
