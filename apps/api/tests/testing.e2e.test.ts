import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { SandboxResult } from "@unumcp/sandbox";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { SANDBOX_RUNNER, type SandboxRunner } from "../src/testing/sandbox-runner";

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

// The fake sandbox returns whatever the current test sets — no Docker needed.
let nextResult: SandboxResult;
const fakeRunner: SandboxRunner = { run: async () => nextResult };

function phase(ok: boolean, log: string, timedOut = false) {
  return { ok, exitCode: ok ? 0 : 1, log, timedOut };
}

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Widgets", version: "1.0.0" },
  servers: [{ url: "https://api.widgets.test" }],
  paths: {
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
});

async function makeUser(tag: string): Promise<string> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const res = await request(app.getHttpServer())
    .post("/auth/register")
    .send({ email, password: "password123" });
  return res.body.accessToken;
}

/** upload → propose → approve → generate, leaving the project ready to test. */
async function generatedProject(token: string): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Widgets" });
  const projectId = project.body.id;
  await request(app.getHttpServer())
    .post(`/projects/${projectId}/spec/upload`)
    .set(auth)
    .send({ filename: "widgets.json", content: spec });
  await request(app.getHttpServer()).post(`/projects/${projectId}/tools/propose`).set(auth);
  await request(app.getHttpServer()).post(`/projects/${projectId}/tools/approve`).set(auth);
  await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);
  return projectId;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_RUNNER)
    .useValue(fakeRunner)
    .compile();
  app = moduleRef.createNestApplication();
  prisma = app.get(PrismaService);
  await app.init();
});

afterAll(async () => {
  for (const email of emails) {
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  await app.close();
});

describe("sandbox test execution (P4-3/4/7)", () => {
  it("runs tests, persists a passing TestResult, advances to TESTS_PASSED", async () => {
    const token = await makeUser("testpass");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await generatedProject(token);
    nextResult = {
      install: phase(true, "added 50 packages"),
      test: phase(true, "      Tests  4 passed (4)\n"),
    };

    const res = await request(app.getHttpServer()).post(`/projects/${projectId}/test`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("passed");
    expect(res.body.summary).toEqual({ passed: 4, failed: 0, skipped: 0, total: 4 });

    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("TESTS_PASSED");

    const results = await request(app.getHttpServer()).get(`/projects/${projectId}/test`).set(auth);
    expect(results.body.results[0].status).toBe("passed");
    expect(results.body.results[0].totalTestCount).toBe(4);
  });

  it("records a failing run and advances to TESTS_FAILED", async () => {
    const token = await makeUser("testfail");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await generatedProject(token);
    nextResult = {
      install: phase(true, "added 50 packages"),
      test: phase(false, "      Tests  1 failed | 3 passed (4)\n"),
    };

    const res = await request(app.getHttpServer()).post(`/projects/${projectId}/test`).set(auth);
    expect(res.body.status).toBe("failed");
    expect(res.body.summary.failed).toBe(1);

    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("TESTS_FAILED");

    const results = await request(app.getHttpServer()).get(`/projects/${projectId}/test`).set(auth);
    expect(results.body.results[0].failingTestCount).toBe(1);
  });

  it("P6-1: redacts secrets from the persisted log excerpt (NFR-001)", async () => {
    const token = await makeUser("testredact");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await generatedProject(token);
    const leaked = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    nextResult = {
      install: phase(true, "added 50 packages"),
      test: phase(false, `FAIL: request used Authorization: Bearer ${leaked}\n  Tests  1 failed (1)\n`),
    };

    await request(app.getHttpServer()).post(`/projects/${projectId}/test`).set(auth);

    const run = await prisma.generationRun.findFirstOrThrow({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    const result = await prisma.testResult.findFirstOrThrow({ where: { generationRunId: run.id } });
    expect(result.logExcerpt).toContain("***REDACTED***");
    expect(result.logExcerpt).not.toContain(leaked);
  });

  it("treats install failure as a sandbox error (SANDBOX_FAILED)", async () => {
    const token = await makeUser("testinstall");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await generatedProject(token);
    nextResult = {
      install: phase(false, "npm ERR! network unreachable"),
      test: phase(false, "skipped (install failed)"),
    };

    const res = await request(app.getHttpServer()).post(`/projects/${projectId}/test`).set(auth);
    expect(res.body.status).toBe("errored");

    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("SANDBOX_FAILED");
  });

  it("treats a test-phase timeout as a sandbox error", async () => {
    const token = await makeUser("testtimeout");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await generatedProject(token);
    nextResult = {
      install: phase(true, "added 50 packages"),
      test: { ok: false, exitCode: null, log: "", timedOut: true },
    };

    const res = await request(app.getHttpServer()).post(`/projects/${projectId}/test`).set(auth);
    expect(res.body.status).toBe("errored");
    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("SANDBOX_FAILED");
  });

  it("refuses to test before generation", async () => {
    const token = await makeUser("nogen");
    const auth = { Authorization: `Bearer ${token}` };
    const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "P" });
    const res = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/test`)
      .set(auth);
    expect(res.status).toBe(400);
  });

  it("enforces ownership on test routes", async () => {
    const owner = await makeUser("towner");
    const other = await makeUser("tintruder");
    const projectId = await generatedProject(owner);
    const res = await request(app.getHttpServer())
      .post(`/projects/${projectId}/test`)
      .set({ Authorization: `Bearer ${other}` });
    expect(res.status).toBe(404);
  });
});
