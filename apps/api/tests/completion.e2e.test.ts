import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import JSZip from "jszip";
import type { SandboxResult } from "@unumcp/sandbox";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { SANDBOX_RUNNER, type SandboxRunner } from "../src/testing/sandbox-runner";

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

// Tests always pass in this suite — completion is what's under test.
const passingResult: SandboxResult = {
  install: { ok: true, exitCode: 0, log: "added 60 packages", timedOut: false },
  test: { ok: true, exitCode: 0, log: "      Tests  3 passed (3)\n", timedOut: false },
};
const fakeRunner: SandboxRunner = { run: async () => passingResult };

function readEndpoint(operationId: string) {
  return {
    get: {
      operationId,
      responses: {
        "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } },
      },
    },
  };
}

// Three low-risk GET endpoints → all enabled by default → ≥3 approved tools (P5-7).
function sampleSpec(secured: boolean): string {
  const doc: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title: "Catalog", version: "1.0.0" },
    servers: [{ url: "https://api.catalog.test" }],
    paths: {
      "/widgets": readEndpoint("listWidgets"),
      "/gadgets": readEndpoint("listGadgets"),
      "/gizmos": readEndpoint("listGizmos"),
    },
  };
  if (secured) {
    doc.security = [{ bearerAuth: [] }];
    doc.components = { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } };
  }
  return JSON.stringify(doc);
}

async function makeUser(tag: string): Promise<string> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const res = await request(app.getHttpServer())
    .post("/auth/register")
    .send({ email, password: "password123" });
  return res.body.accessToken;
}

/** Drive a project all the way to TESTS_PASSED. */
async function testedProject(token: string, secured: boolean): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Catalog" });
  const projectId = project.body.id;
  await request(app.getHttpServer())
    .post(`/projects/${projectId}/spec/upload`)
    .set(auth)
    .send({ filename: "catalog.json", content: sampleSpec(secured) });
  await request(app.getHttpServer()).post(`/projects/${projectId}/tools/propose`).set(auth);
  await request(app.getHttpServer()).post(`/projects/${projectId}/tools/approve`).set(auth);
  await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);
  await request(app.getHttpServer()).post(`/projects/${projectId}/test`).set(auth);
  return projectId;
}

function binaryParser(res: any, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
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

describe("completion flow (P5-4/7, P4-7 terminal states)", () => {
  it("P5-7 acceptance: spec → ≥3 tools → tests pass → COMPLETED → ZIP + audit trail", async () => {
    const token = await makeUser("accept");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await testedProject(token, /* secured */ true);

    // ≥3 approved tools.
    const tools = await request(app.getHttpServer()).get(`/projects/${projectId}/tools`).set(auth);
    const approved = tools.body.filter((t: any) => t.approved);
    expect(approved.length).toBeGreaterThanOrEqual(3);

    // Complete → clean terminal state (auth detected, tests ran → no warnings).
    const done = await request(app.getHttpServer()).post(`/projects/${projectId}/complete`).set(auth);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("COMPLETED");
    expect(done.body.warnings).toEqual([]);

    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("COMPLETED");

    // Valid project ZIP with README + .env.example, no secrets file.
    const zipRes = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/download`)
      .set(auth)
      .buffer()
      .parse(binaryParser);
    const zip = await JSZip.loadAsync(zipRes.body);
    const paths = Object.keys(zip.files);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("README.md");
    expect(paths).toContain(".env.example");
    expect(paths).not.toContain(".env");
    expect(paths.filter((p) => p.startsWith("src/tools/")).length).toBeGreaterThanOrEqual(3);

    // Audit trail covers the full pipeline.
    const audit = await request(app.getHttpServer()).get(`/projects/${projectId}/audit`).set(auth);
    const types = audit.body.map((e: any) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining(["tools_approved", "code_generated", "tests_run", "project_completed"]),
    );
  });

  it("P5-4: a spec without auth completes WITH warnings and embeds WARNINGS.md", async () => {
    const token = await makeUser("warn");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await testedProject(token, /* secured */ false);

    const done = await request(app.getHttpServer()).post(`/projects/${projectId}/complete`).set(auth);
    expect(done.body.status).toBe("COMPLETED_WITH_WARNINGS");
    expect(done.body.warnings.length).toBeGreaterThan(0);

    const zipRes = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/download`)
      .set(auth)
      .buffer()
      .parse(binaryParser);
    const zip = await JSZip.loadAsync(zipRes.body);
    expect(Object.keys(zip.files)).toContain("WARNINGS.md");
    const warningsDoc = await zip.file("WARNINGS.md")!.async("string");
    expect(warningsDoc).toMatch(/auto-detected/i);
  });

  it("refuses to complete before tests pass", async () => {
    const token = await makeUser("early");
    const auth = { Authorization: `Bearer ${token}` };
    const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Early" });
    const res = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/complete`)
      .set(auth);
    expect(res.status).toBe(400);
  });

  it("enforces ownership on the complete route", async () => {
    const owner = await makeUser("cowner");
    const other = await makeUser("cintruder");
    const projectId = await testedProject(owner, true);
    const res = await request(app.getHttpServer())
      .post(`/projects/${projectId}/complete`)
      .set({ Authorization: `Bearer ${other}` });
    expect(res.status).toBe(404);
  });
});
