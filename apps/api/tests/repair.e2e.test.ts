import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SandboxResult } from "@unumcp/sandbox";
import type { RepairInput, RepairResult } from "@unumcp/llm";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/storage/storage.service";
import { LlmService } from "../src/llm/llm.service";
import { RepairService } from "../src/repair/repair.service";
import type { SandboxRunner } from "../src/testing/sandbox-runner";

const BUGGY = "export const ok = (r: { ok: boolean }) => { if (r.ok) throw new Error('boom'); };\n";
const FIXED = "export const ok = (r: { ok: boolean }) => { if (!r.ok) throw new Error('boom'); };\n";

const PASS_LOG = "Test Files  1 passed (1)\n Tests  1 passed (1)\n";
const FAIL_LOG = "Test Files  1 failed (1)\n Tests  1 failed | 0 passed (1)\n";

function sandboxLog(testLog: string): SandboxResult {
  return {
    install: { ok: true, exitCode: 0, log: "added 1 package", timedOut: false },
    test: { ok: testLog === PASS_LOG, exitCode: testLog === PASS_LOG ? 0 : 1, log: testLog, timedOut: false },
  };
}

/** An LlmService stand-in that returns a canned repair (no provider call). */
function fakeLlm(repair: (input: RepairInput) => Promise<RepairResult>): LlmService {
  return { enabled: true, repair } as unknown as LlmService;
}

const usage = { inputTokens: 10, outputTokens: 5 };

let app: INestApplication;
let prisma: PrismaService;
let storage: StorageService;
const userIds: string[] = [];

/** Seed a project whose latest run failed its tests, with a buggy source artifact. */
async function seedFailedRun(tag: string): Promise<{ projectId: string; runId: string; sourceUrl: string }> {
  const user = await prisma.user.create({
    data: { email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, passwordHash: "x" },
  });
  userIds.push(user.id);
  const project = await prisma.project.create({
    data: { userId: user.id, name: tag, status: "TESTS_FAILED" },
  });
  const run = await prisma.generationRun.create({
    data: { projectId: project.id, status: "failed", mcpSdkVersion: "1.29.0" },
  });

  const sourceUrl = await storage.save(`${project.id}/generated/${run.id}/src/lib.ts`, BUGGY);
  const testUrl = await storage.save(`${project.id}/generated/${run.id}/tests/lib.test.ts`, "// frozen\n");
  await prisma.generatedArtifact.create({
    data: { projectId: project.id, artifactType: "source_file", path: "src/lib.ts", contentUrl: sourceUrl, contentHash: "old" },
  });
  await prisma.generatedArtifact.create({
    data: { projectId: project.id, artifactType: "test_file", path: "tests/lib.test.ts", contentUrl: testUrl, contentHash: "frozen" },
  });
  await prisma.testResult.create({
    data: { generationRunId: run.id, suite: "vitest", status: "failed", durationMs: 100, failingTestCount: 1, totalTestCount: 1, logExcerpt: FAIL_LOG },
  });

  return { projectId: project.id, runId: run.id, sourceUrl };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  await app.init();
});

afterAll(async () => {
  for (const id of userIds) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }
  await app.close();
});

describe("repair loop orchestrator (P4-5/P4-6, FR-026)", () => {
  it("fixes the implementation and drives the run to TESTS_PASSED", async () => {
    const { projectId, runId, sourceUrl } = await seedFailedRun("repair-ok");

    const llm = fakeLlm(async () => ({
      files: [{ path: "src/lib.ts", content: FIXED }],
      usage,
      model: "fake",
      latencyMs: 1,
    }));
    // Sandbox passes once the fix is applied.
    const sandbox: SandboxRunner = { run: async () => sandboxLog(PASS_LOG) };
    const service = new RepairService(prisma, storage, sandbox, llm, { maxAttempts: 2, maxTokens: 100 });

    const result = await service.repairFailingRun(projectId);
    expect(result).toEqual({ repaired: true, attempts: 1 });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("TESTS_PASSED");

    const run = await prisma.generationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("passed");
    expect(run.repairAttempts).toBe(1);

    const attempts = await prisma.repairAttempt.findMany({ where: { generationRunId: runId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("passed");
    expect(attempts[0]?.diff).toContain("+export const ok");

    // The stored artifact now holds the fixed source (so the ZIP reflects the repair).
    expect(await storage.read(sourceUrl)).toBe(FIXED);
  });

  it("stops at maxAttempts and leaves the run TESTS_FAILED (never silent success)", async () => {
    const { projectId, runId } = await seedFailedRun("repair-exhaust");

    const llm = fakeLlm(async () => ({
      files: [{ path: "src/lib.ts", content: FIXED }],
      usage,
      model: "fake",
      latencyMs: 1,
    }));
    // Sandbox keeps failing — the fix didn't help.
    const sandbox: SandboxRunner = { run: async () => sandboxLog(FAIL_LOG) };
    const service = new RepairService(prisma, storage, sandbox, llm, { maxAttempts: 2, maxTokens: 100 });

    const result = await service.repairFailingRun(projectId);
    expect(result).toEqual({ repaired: false, attempts: 2 });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("TESTS_FAILED");

    const run = await prisma.generationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.repairAttempts).toBe(2);
    const attempts = await prisma.repairAttempt.findMany({ where: { generationRunId: runId } });
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.outcome === "failed")).toBe(true);
  });

  it("records a failed attempt and settles TESTS_FAILED when the model touches a frozen test", async () => {
    const { projectId, runId } = await seedFailedRun("repair-frozen");

    // The model tries to edit a test file — repairCode rejects it, so repair() throws.
    const llm = fakeLlm(async () => {
      throw new Error("Repair attempted to edit a frozen test file: tests/lib.test.ts");
    });
    const sandbox: SandboxRunner = { run: async () => sandboxLog(PASS_LOG) };
    const service = new RepairService(prisma, storage, sandbox, llm, { maxAttempts: 2, maxTokens: 100 });

    const result = await service.repairFailingRun(projectId);
    expect(result).toEqual({ repaired: false, attempts: 1 });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("TESTS_FAILED");
    const attempts = await prisma.repairAttempt.findMany({ where: { generationRunId: runId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("failed");
  });

  it("is a no-op when the LLM is disabled", async () => {
    const { projectId } = await seedFailedRun("repair-disabled");
    const disabled = { enabled: false, repair: async () => { throw new Error("nope"); } } as unknown as LlmService;
    const sandbox: SandboxRunner = { run: async () => sandboxLog(PASS_LOG) };
    const service = new RepairService(prisma, storage, sandbox, disabled, { maxAttempts: 2, maxTokens: 100 });

    expect(await service.repairFailingRun(projectId)).toEqual({ repaired: false, attempts: 0 });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("TESTS_FAILED");
  });
});
