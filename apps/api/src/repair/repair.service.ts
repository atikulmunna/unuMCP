import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateRun, truncateLog, type SandboxResult, type TestSummary } from "@unumcp/sandbox";
import { redactSecrets, summarizeScan, type ScanResult } from "@unumcp/security-scan";
import { unifiedDiff, type RepairFile } from "@unumcp/llm";
import {
  ArtifactType,
  ProjectStatus,
  RepairOutcome,
  TestStatus,
  type GeneratedArtifact,
  type GenerationRun,
  type GenerationStatus,
} from "@unumcp/db";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { LlmService } from "../llm/llm.service";
import { estimateCostUsd } from "../llm/llm-pricing";
import { SANDBOX_RUNNER, type SandboxRunner } from "../testing/sandbox-runner";
import { REPAIR_SUITE } from "../testing/test-results";
import { DEFAULT_BASE_URL, scanForPackaging } from "../generation/security-gate";
import { repairConfigFromEnv, type RepairConfig } from "./repair.config";

export interface RepairSummary {
  repaired: boolean;
  attempts: number;
}

const FAILURE_SUMMARY_CAP = 4_000;
const DIFF_CAP = 20_000;

/**
 * The only files a repair may edit: implementation sources under `src/`. Tests,
 * the README, and project config (`package.json` scripts and dependencies,
 * `tsconfig.json`, `.env.example`) stay frozen, so a repair can neither neuter
 * the test harness nor pull in a new dependency.
 */
function isRepairEditable(path: string): boolean {
  return path.startsWith("src/") && path.endsWith(".ts") && !path.endsWith(".test.ts");
}

/**
 * Bounded self-repair loop (P4-5/P4-6, FR-026, §11.4). After a clean test
 * failure: read the failure → ask the LLM to fix the **implementation only** →
 * security-scan the edit → rerun the sandbox → repeat up to `maxAttempts`.
 * Tests are frozen (only {@link isRepairEditable} files are offered, and the
 * repair parser rejects any path outside that set), and every edit passes the
 * same security gate as generated code before it is applied. Attempts run on a
 * working copy: stored code changes only when an attempt passes, so an exhausted
 * loop leaves the generated code untouched. Every pass is persisted as a
 * `RepairAttempt` (diff + failure + outcome) so the user can inspect the history;
 * on exhaustion the project stays `TESTS_FAILED`, never a silent success.
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
   * LLM is disabled or there is nothing to repair: it returns a no-op summary.
   */
  async repairFailingRun(projectId: string): Promise<RepairSummary> {
    const target = this.enabled ? await this.findRepairTarget(projectId) : null;
    if (!target) return { repaired: false, attempts: 0 };

    const dir = await mkdtemp(join(tmpdir(), "unumcp-repair-"));
    try {
      // Materialize the whole project once; only changed files are overwritten between passes.
      for (const a of target.artifacts) {
        const dest = join(dir, a.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, await this.storage.read(a.contentUrl as string));
      }
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.REPAIRING_FAILED_CODE },
      });

      const summary = await this.attemptRepairs(target, dir);
      if (!summary.repaired) await this.settleExhausted(projectId, summary.attempts);
      return summary;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The latest run's last failure and its editable sources, or null when there's nothing to repair. */
  private async findRepairTarget(projectId: string): Promise<RepairTarget | null> {
    const run = await this.prisma.generationRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    if (!run) return null;

    const lastFailure = await this.prisma.testResult.findFirst({
      where: { generationRunId: run.id, status: TestStatus.failed },
      orderBy: { createdAt: "desc" },
    });
    if (!lastFailure) return null;

    const artifacts = await this.prisma.generatedArtifact.findMany({
      where: { projectId, contentUrl: { not: null } },
    });
    const editable = artifacts.filter(
      (a) => a.artifactType === ArtifactType.source_file && isRepairEditable(a.path),
    );
    if (editable.length === 0) return null;

    // Repaired code must stay within the same host allowlist as generated code.
    const spec = await this.prisma.apiSpec.findFirst({
      where: { projectId, validationStatus: "valid" },
      orderBy: { createdAt: "desc" },
      select: { baseUrl: true },
    });
    return {
      projectId,
      run,
      failureLog: lastFailure.logExcerpt ?? "",
      artifacts,
      editable: new Map(editable.map((a) => [a.path, a])),
      baseUrl: spec?.baseUrl ?? DEFAULT_BASE_URL,
    };
  }

  /**
   * Up to `maxAttempts` passes. Attempts edit an in-memory copy of the stored
   * (generated) sources, each building on the previous one's code; storage
   * changes only when an attempt passes, so an exhausted loop never ships an
   * unverified model edit.
   */
  private async attemptRepairs(target: RepairTarget, dir: string): Promise<RepairSummary> {
    const original = new Map(
      await Promise.all(
        [...target.editable.values()].map(
          async (a) => [a.path, await this.storage.read(a.contentUrl as string)] as const,
        ),
      ),
    );
    const code = { original, current: new Map(original) };
    // Accrue LLM cost across passes onto the run (NFR-007b, P6-7). Seeded from
    // the run's current totals (proposal cost from generation) and SET each pass
    // so it's null-safe (a plain `increment` on a NULL column stays NULL).
    const cost: RunCost = {
      inputTokens: target.run.inputTokens ?? 0,
      outputTokens: target.run.outputTokens ?? 0,
      costUsd: Number(target.run.estimatedCostUsd ?? 0),
    };

    let failureLog = target.failureLog;
    let attempts = 0;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      attempts = attempt;
      const outcome = await this.attemptOnce(target, dir, attempt, failureLog, code, cost);
      if (outcome.status === "passed") {
        this.logger.log(`Repair succeeded for project ${target.projectId} after ${attempt} attempt(s).`);
        return { repaired: true, attempts };
      }
      if (outcome.status === "stopped") break;
      failureLog = outcome.log;
    }
    return { repaired: false, attempts };
  }

  /** One pass: ask for a fix, scan it, apply it to the working copy, and rerun the tests. */
  private async attemptOnce(
    target: RepairTarget,
    dir: string,
    attempt: number,
    failureLog: string,
    code: { original: Map<string, string>; current: Map<string, string> },
    cost: RunCost,
  ): Promise<AttemptOutcome> {
    const { projectId, run } = target;
    const changed = await this.askForFix(target, attempt, failureLog, code.current, cost);
    if (!changed) return { status: "stopped" };

    // Diff against this attempt's starting code (so each attempt's diff is its own edit).
    const diff = changed
      .map((f) => unifiedDiff(code.current.get(f.path) ?? "", f.content, f.path))
      .filter((d) => d.length > 0)
      .join("\n\n");

    // Security gate before anything is written: repaired code is model-authored,
    // so it gets the same scan as generated code. Only the changed files need
    // scanning; the rest already passed at generation.
    const scan = scanForPackaging(changed, target.baseUrl);
    if (!scan.passed) {
      await this.rejectInsecureRepair(projectId, run.id, attempt, failureLog, diff, scan);
      return { status: "stopped" };
    }

    // Apply to the working copy only (repairCode already enforces the editable allowlist).
    for (const f of changed) {
      code.current.set(f.path, f.content);
      await writeFile(join(dir, f.path), f.content);
    }

    const startedAt = Date.now();
    const result = await this.sandbox.run(dir);
    const durationMs = Date.now() - startedAt;
    const { summary, passed, infraFailed, log } = classifyRun(result);

    // A passing fix is saved before its result is recorded, so a TESTS_PASSED
    // project always has the tested code in storage.
    if (passed) await this.saveRepairedSources(target.editable, code.original, code.current);

    const outcome = passed ? RepairOutcome.passed : RepairOutcome.failed;
    await this.recordAttempt(run.id, attempt, failureLog, diff, outcome);
    await this.recordRerun(run.id, projectId, summary, durationMs, log, passed, infraFailed);
    return passed ? { status: "passed" } : { status: "failed", log };
  }

  /**
   * Ask the LLM for a fix and accrue the call's cost onto the run. Returns null,
   * after recording the failed attempt, on an LLM error or a rejected edit (for
   * example one that tried to touch a frozen test).
   */
  private async askForFix(
    target: RepairTarget,
    attempt: number,
    failureLog: string,
    current: Map<string, string>,
    cost: RunCost,
  ): Promise<RepairFile[] | null> {
    const files: RepairFile[] = [...current].map(([path, content]) => ({ path, content }));
    try {
      const result = await this.llm.repair(
        { failureLog, files, maxTokens: this.config.maxTokens },
        { projectId: target.projectId },
      );
      cost.inputTokens += result.usage.inputTokens;
      cost.outputTokens += result.usage.outputTokens;
      cost.costUsd += estimateCostUsd(result.model, result.usage.inputTokens, result.usage.outputTokens);
      await this.prisma.generationRun.update({
        where: { id: target.run.id },
        data: {
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
          estimatedCostUsd: cost.costUsd,
          llmModelId: result.model,
        },
      });
      return result.files;
    } catch (err) {
      this.logger.warn(
        `Repair attempt ${attempt} produced no usable fix (${err instanceof Error ? err.name : "error"}); stopping.`,
      );
      await this.recordAttempt(target.run.id, attempt, failureLog, "", RepairOutcome.failed);
      return null;
    }
  }

  /**
   * Exhausted, or stopped early before a rerun: never leave the project
   * mid-repair. Settle on TESTS_FAILED (partial output, never silent success)
   * with the generated code still in storage, untouched.
   */
  private async settleExhausted(projectId: string, attempts: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.TESTS_FAILED },
      }),
      this.prisma.auditEvent.create({
        data: {
          projectId,
          eventType: "repair_exhausted",
          actor: "agent",
          summary: `Repair did not pass after ${attempts} attempt(s); the generated code was kept unchanged (every attempt is in the repair history).`,
        },
      }),
    ]);
    this.logger.warn(`Repair did not pass after ${attempts} attempt(s) for project ${projectId}; left TESTS_FAILED.`);
  }

  /**
   * A repair that fails the security scan is never applied: record the attempt
   * as failed (with the rejected diff, redacted) plus a `security_scan_failed`
   * audit event, so it shows in the history and in the security metrics.
   */
  private async rejectInsecureRepair(
    projectId: string,
    runId: string,
    attempt: number,
    failureLog: string,
    diff: string,
    scan: ScanResult,
  ): Promise<void> {
    const high = scan.findings.filter((f) => f.severity === "high");
    this.logger.warn(
      `Repair attempt ${attempt} for project ${projectId} failed the security scan (${high.length} high); not applied.`,
    );
    await this.recordAttempt(runId, attempt, failureLog, redactSecrets(diff), RepairOutcome.failed);
    await this.prisma.auditEvent.create({
      data: {
        projectId,
        eventType: "security_scan_failed",
        actor: "agent",
        summary: `Repair attempt ${attempt} failed the security scan and was not applied: ${summarizeScan(scan)}`,
        metadata: JSON.parse(JSON.stringify({ findings: high.slice(0, 20) })),
      },
    });
  }

  /** Persist every source the passing repair changed relative to the stored version. */
  private async saveRepairedSources(
    byPath: Map<string, GeneratedArtifact>,
    original: Map<string, string>,
    current: Map<string, string>,
  ): Promise<void> {
    for (const [path, content] of current) {
      const artifact = byPath.get(path);
      if (artifact && content !== original.get(path)) await this.persistArtifact(artifact, content);
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
          suite: REPAIR_SUITE,
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

/** What a repair works on: the failing run, its last failure, and its sources. */
interface RepairTarget {
  projectId: string;
  run: GenerationRun;
  failureLog: string;
  /** Every stored artifact, to materialize the whole project. */
  artifacts: GeneratedArtifact[];
  /** The sources a repair may edit, by path. */
  editable: Map<string, GeneratedArtifact>;
  baseUrl: string;
}

/** LLM usage accrued onto the run across repair passes. */
interface RunCost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

type AttemptOutcome = { status: "passed" } | { status: "stopped" } | { status: "failed"; log: string };

interface RunOutcome {
  summary: TestSummary;
  passed: boolean;
  infraFailed: boolean;
  log: string;
}

/** Classify a sandbox rerun with the same `evaluateRun` rule `TestingService` uses. */
function classifyRun(result: SandboxResult): RunOutcome {
  const { summary, passed, infraFailed } = evaluateRun(result);
  // The failing phase's log: preparation if it failed, otherwise the test run
  // (which holds the timeout or out-of-memory evidence for an infra failure).
  const log = truncateLog(redactSecrets(result.install.ok ? result.test.log : result.install.log));
  return { summary, passed, infraFailed, log };
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}
