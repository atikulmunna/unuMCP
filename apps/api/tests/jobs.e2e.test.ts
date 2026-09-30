import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { JobReconciler } from "../src/jobs/job-reconciler";
import { GenerationService } from "../src/generation/generation.service";

let app: INestApplication;
let prisma: PrismaService;
let reconciler: JobReconciler;
let generation: GenerationService;
const emails: string[] = [];

async function seedProject(tag: string): Promise<string> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const user = await prisma.user.create({ data: { email, passwordHash: "x" } });
  const project = await prisma.project.create({ data: { userId: user.id, name: tag } });
  return project.id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  prisma = app.get(PrismaService);
  reconciler = app.get(JobReconciler);
  generation = app.get(GenerationService);
  await app.init();
});

afterAll(async () => {
  for (const email of emails) {
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  await app.close();
});

describe("job recovery + idempotency (P6-6, NFR-006)", () => {
  it("reconciles an orphaned 'running' run into a failed state", async () => {
    const projectId = await seedProject("orphan");
    await prisma.project.update({ where: { id: projectId }, data: { status: "CODE_GENERATING" } });
    // Backdate so it's past the staleness threshold (a real orphan, not in-flight).
    const run = await prisma.generationRun.create({
      data: {
        projectId,
        status: "running",
        mcpSdkVersion: "1.29.0",
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    // Assert the OUTCOME (run becomes failed), not the count — a parallel test
    // file's bootstrap reconcile could legitimately recover the same stale run.
    await reconciler.reconcile();

    const after = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("failed");
    expect(after.completedAt).not.toBeNull();
    expect(after.errorMessage).toMatch(/recovered after a restart/i);

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("GENERATION_FAILED");
  });

  it("recovers projects stranded mid-test or mid-repair, leaving recent ones alone", async () => {
    const stale = new Date(Date.now() - 20 * 60 * 1000);
    const testing = await seedProject("stranded-test");
    const repairing = await seedProject("stranded-repair");
    const live = await seedProject("live-test");
    await prisma.project.update({ where: { id: testing }, data: { status: "TEST_RUNNING", updatedAt: stale } });
    await prisma.project.update({ where: { id: repairing }, data: { status: "REPAIRING_FAILED_CODE", updatedAt: stale } });
    // Updated just now: plausibly still running on another instance.
    await prisma.project.update({ where: { id: live }, data: { status: "TEST_RUNNING" } });

    await reconciler.reconcileStages();

    const statusOf = async (id: string) =>
      (await prisma.project.findUniqueOrThrow({ where: { id } })).status;
    expect(await statusOf(testing)).toBe("SANDBOX_FAILED");
    expect(await statusOf(repairing)).toBe("TESTS_FAILED");
    expect(await statusOf(live)).toBe("TEST_RUNNING");

    const events = await prisma.auditEvent.findMany({
      where: { projectId: { in: [testing, repairing] }, eventType: "run_recovered" },
    });
    const summaryFor = (id: string) => events.find((e) => e.projectId === id)?.summary;
    expect(summaryFor(testing)).toMatch(/sandbox test run did not finish/);
    expect(summaryFor(repairing)).toMatch(/repair loop did not finish/);
  });

  it("refuses a second concurrent generation run (no duplicate artifacts)", async () => {
    const projectId = await seedProject("dup");
    // Simulate a run already in flight.
    await prisma.generationRun.create({
      data: { projectId, status: "running", mcpSdkVersion: "1.29.0" },
    });

    await expect(generation.generate(projectId, "user-x")).rejects.toThrow(/already in progress/i);
  });
});
