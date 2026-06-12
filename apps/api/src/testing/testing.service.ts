import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseTestSummary, truncateLog, type SandboxResult } from "@unumcp/sandbox";
import { redactSecrets } from "@unumcp/security-scan";
import { ProjectStatus, TestStatus, type GenerationStatus } from "@unumcp/db";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SANDBOX_RUNNER, type SandboxRunner } from "./sandbox-runner";

@Injectable()
export class TestingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(SANDBOX_RUNNER) private readonly sandbox: SandboxRunner,
  ) {}

  /**
   * Run the generated server's tests in the two-phase sandbox (P4-3/4). The
   * project is materialized from its stored artifacts into a clean temp dir (no
   * host `node_modules` — finding F-3), installed then tested offline, and the
   * outcome is persisted as a `TestResult` with the project state advanced.
   */
  async runTests(projectId: string) {
    const run = await this.prisma.generationRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    if (!run) throw new BadRequestException("Generate the server before running tests.");

    const artifacts = await this.prisma.generatedArtifact.findMany({
      where: { projectId, contentUrl: { not: null } },
    });
    if (artifacts.length === 0) {
      throw new BadRequestException("No generated artifacts to test.");
    }

    const dir = await mkdtemp(join(tmpdir(), "unumcp-sbx-"));
    try {
      for (const a of artifacts) {
        const dest = join(dir, a.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, await this.storage.read(a.contentUrl as string));
      }

      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.TEST_RUNNING },
      });

      const startedAt = Date.now();
      const result = await this.sandbox.run(dir);
      const durationMs = Date.now() - startedAt;

      return await this.record(projectId, run.id, result, durationMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Latest run's test results (§14.6). */
  async getResults(projectId: string) {
    const run = await this.prisma.generationRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    if (!run) return null;
    const results = await this.prisma.testResult.findMany({
      where: { generationRunId: run.id },
      orderBy: { createdAt: "desc" },
    });
    return { runId: run.id, results };
  }

  private async record(
    projectId: string,
    runId: string,
    result: SandboxResult,
    durationMs: number,
  ) {
    const installFailed = !result.install.ok;
    const summary = parseTestSummary(result.test.log);
    const testsPassed = result.test.ok && summary.failed === 0 && !result.test.timedOut;

    // A sandbox/install failure or timeout is an infrastructure error, distinct
    // from a clean test failure (which feeds the repair loop in P4-5).
    let status: TestStatus;
    let projectStatus: ProjectStatus;
    let runStatus: GenerationStatus;
    if (installFailed || result.test.timedOut) {
      status = TestStatus.errored;
      projectStatus = ProjectStatus.SANDBOX_FAILED;
      runStatus = "failed";
    } else if (testsPassed) {
      status = TestStatus.passed;
      projectStatus = ProjectStatus.TESTS_PASSED;
      runStatus = "passed";
    } else {
      status = TestStatus.failed;
      projectStatus = ProjectStatus.TESTS_FAILED;
      runStatus = "failed";
    }

    // Redact any secret that leaked into sandbox output before it is persisted
    // or shown in the UI (NFR-001). Redact first, then cap the length.
    const logExcerpt = truncateLog(redactSecrets(installFailed ? result.install.log : result.test.log));

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
          eventType: "tests_run",
          actor: "agent",
          summary: `Tests ${status}: ${summary.passed}/${summary.total} passed`,
        },
      }),
    ]);

    return { status, summary, durationMs };
  }
}
