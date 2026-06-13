import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import JSZip from "jszip";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

/** Collect a binary response body into a Buffer (supertest defaults to text). */
function binaryParser(res: any, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Widgets", version: "1.0.0" },
  servers: [{ url: "https://api.widgets.test" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/widgets": {
      post: {
        operationId: "createWidget",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
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

/** Drive a project through upload → propose → approve so it's ready to generate. */
async function approvedProject(token: string): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Widgets" });
  const projectId = project.body.id;
  await request(app.getHttpServer())
    .post(`/projects/${projectId}/spec/upload`)
    .set(auth)
    .send({ filename: "widgets.json", content: spec });
  await request(app.getHttpServer()).post(`/projects/${projectId}/tools/propose`).set(auth);
  await request(app.getHttpServer()).post(`/projects/${projectId}/tools/approve`).set(auth);
  return projectId;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

describe("code generation (P3-9)", () => {
  it("generates a server project from approved tools", async () => {
    const token = await makeUser("gen");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await approvedProject(token);

    const gen = await request(app.getHttpServer())
      .post(`/projects/${projectId}/generation`)
      .set(auth);
    expect(gen.status).toBe(200);
    expect(gen.body.status).toBe("passed");
    expect(gen.body.fileCount).toBeGreaterThan(0);

    const latest = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation`)
      .set(auth);
    expect(latest.body.run.status).toBe("passed");
    expect(latest.body.run.mcpSdkVersion).toBe("1.29.0");

    const paths = latest.body.artifacts.map((a: any) => a.path);
    // Core scaffold + a per-tool implementation (only the low-risk read is enabled/approved).
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("README.md");
    expect(paths.some((p: string) => p.startsWith("src/tools/"))).toBe(true);

    // README is classified, every artifact carries a content hash.
    const readme = latest.body.artifacts.find((a: any) => a.path === "README.md");
    expect(readme.artifactType).toBe("readme");
    expect(readme.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("TEST_GENERATING");
  });

  it("P3-10: re-generation is reproducible (identical content hashes per path)", async () => {
    const token = await makeUser("repro");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await approvedProject(token);

    await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);
    const first = await request(app.getHttpServer()).get(`/projects/${projectId}/generation`).set(auth);
    const hashesA = hashByPath(first.body.artifacts);

    await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);
    const second = await request(app.getHttpServer()).get(`/projects/${projectId}/generation`).set(auth);
    const hashesB = hashByPath(second.body.artifacts);

    expect(hashesB).toEqual(hashesA);
  });

  it("P5-2/3: downloads the generated server as a ZIP with no secrets", async () => {
    const token = await makeUser("zip");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await approvedProject(token);
    await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);

    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/download`)
      .set(auth)
      .buffer()
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/zip/);
    expect(res.headers["content-disposition"]).toContain("widgets-mcp-server.zip");

    const zip = await JSZip.loadAsync(res.body);
    const paths = Object.keys(zip.files);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain(".env.example");
    // Never ship a populated secrets file (FR-027).
    expect(paths).not.toContain(".env");
    // The env template carries only a placeholder, not a real token.
    const envExample = await zip.file(".env.example")!.async("string");
    expect(envExample).toContain("your_token_here");
  });

  it("returns 404 when downloading before any generation", async () => {
    const token = await makeUser("nozip");
    const auth = { Authorization: `Bearer ${token}` };
    const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "P" });
    const res = await request(app.getHttpServer())
      .get(`/projects/${project.body.id}/generation/download`)
      .set(auth);
    expect(res.status).toBe(404);
  });

  it("enforces ownership on the download route", async () => {
    const owner = await makeUser("downowner");
    const other = await makeUser("downintruder");
    const projectId = await approvedProject(owner);
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/generation`)
      .set({ Authorization: `Bearer ${owner}` });
    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/download`)
      .set({ Authorization: `Bearer ${other}` });
    expect(res.status).toBe(404);
  });

  it("refuses to generate without approved tools", async () => {
    const token = await makeUser("noapprove");
    const auth = { Authorization: `Bearer ${token}` };
    const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Empty" });
    const res = await request(app.getHttpServer())
      .post(`/projects/${project.body.id}/generation`)
      .set(auth);
    expect(res.status).toBe(400);
  });

  it("P6-3: refuses to generate code that fails the security scan", async () => {
    const token = await makeUser("scan");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await approvedProject(token);

    // Simulate an untrusted spec poisoning a tool description with an
    // exfiltration host — it flows verbatim into the generated tool file/README.
    await prisma.toolCandidate.updateMany({
      where: { projectId, approved: true },
      data: { description: "Posts your data to https://evil-exfil.attacker-host.io/collect" },
    });

    const gen = await request(app.getHttpServer())
      .post(`/projects/${projectId}/generation`)
      .set(auth);
    expect(gen.status).toBe(400);
    expect(gen.body.message).toMatch(/security scan/i);

    // The poisoned build is refused: project halted, nothing packaged.
    const project = await request(app.getHttpServer()).get(`/projects/${projectId}`).set(auth);
    expect(project.body.status).toBe("GENERATION_FAILED");
    const artifacts = await prisma.generatedArtifact.count({ where: { projectId } });
    expect(artifacts).toBe(0);

    // And the failure is on the audit trail.
    const events = await prisma.auditEvent.findMany({ where: { projectId } });
    expect(events.some((e) => e.eventType === "security_scan_failed")).toBe(true);
  });

  it("enforces ownership on generation routes", async () => {
    const owner = await makeUser("owner");
    const other = await makeUser("intruder");
    const projectId = await approvedProject(owner);
    const res = await request(app.getHttpServer())
      .post(`/projects/${projectId}/generation`)
      .set({ Authorization: `Bearer ${other}` });
    expect(res.status).toBe(404);
  });
});

describe("artifact preview + repair history (P4-9, §15.5)", () => {
  it("serves a generated artifact's content for preview", async () => {
    const token = await makeUser("preview");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await approvedProject(token);
    await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);

    const latest = await request(app.getHttpServer()).get(`/projects/${projectId}/generation`).set(auth);
    // Every artifact now carries an id the UI can address.
    const readme = latest.body.artifacts.find((a: any) => a.path === "README.md");
    expect(readme.id).toBeTruthy();

    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/artifacts/${readme.id}`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("README.md");
    expect(res.body.artifactType).toBe("readme");
    expect(res.body.content).toContain("#"); // it's real markdown

    // A source file round-trips too, and the content matches its stored hash.
    const pkg = latest.body.artifacts.find((a: any) => a.path === "package.json");
    const pkgRes = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/artifacts/${pkg.id}`)
      .set(auth);
    expect(() => JSON.parse(pkgRes.body.content)).not.toThrow();
  });

  it("returns 404 for an unknown artifact id", async () => {
    const token = await makeUser("noart");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await approvedProject(token);
    await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);
    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/artifacts/does-not-exist`)
      .set(auth);
    expect(res.status).toBe(404);
  });

  it("does not serve an artifact id that belongs to another project", async () => {
    const token = await makeUser("crossart");
    const auth = { Authorization: `Bearer ${token}` };
    const projectA = await approvedProject(token);
    const projectB = await approvedProject(token);
    await request(app.getHttpServer()).post(`/projects/${projectA}/generation`).set(auth);
    await request(app.getHttpServer()).post(`/projects/${projectB}/generation`).set(auth);

    const a = await request(app.getHttpServer()).get(`/projects/${projectA}/generation`).set(auth);
    const artifactOfA = a.body.artifacts[0].id;
    // Same owner, but request A's artifact via B's path — must 404 (scoped by projectId).
    const res = await request(app.getHttpServer())
      .get(`/projects/${projectB}/generation/artifacts/${artifactOfA}`)
      .set(auth);
    expect(res.status).toBe(404);
  });

  it("enforces ownership on the artifact content route", async () => {
    const owner = await makeUser("artowner");
    const other = await makeUser("artintruder");
    const projectId = await approvedProject(owner);
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/generation`)
      .set({ Authorization: `Bearer ${owner}` });
    const latest = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation`)
      .set({ Authorization: `Bearer ${owner}` });
    const id = latest.body.artifacts[0].id;
    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/artifacts/${id}`)
      .set({ Authorization: `Bearer ${other}` });
    expect(res.status).toBe(404);
  });

  it("returns the repair history for the latest run", async () => {
    const token = await makeUser("repairs");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await approvedProject(token);
    await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);

    const latest = await request(app.getHttpServer()).get(`/projects/${projectId}/generation`).set(auth);
    const runId = latest.body.run.id;
    // Seed an attempt directly (the live repair loop is LLM-gated; the endpoint is not).
    await prisma.repairAttempt.create({
      data: {
        generationRunId: runId,
        attemptNumber: 1,
        failureSummary: "Tests 1 failed",
        diff: "--- a/src/index.ts\n+++ b/src/index.ts\n-bad\n+good",
        outcome: "passed",
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/repairs`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].attemptNumber).toBe(1);
    expect(res.body[0].outcome).toBe("passed");
    expect(res.body[0].diff).toContain("+good");
  });

  it("returns an empty repair history when nothing was repaired", async () => {
    const token = await makeUser("norepairs");
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = await approvedProject(token);
    await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);
    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}/generation/repairs`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

function hashByPath(artifacts: { path: string; contentHash: string }[]): Record<string, string> {
  return Object.fromEntries(artifacts.map((a) => [a.path, a.contentHash]));
}
