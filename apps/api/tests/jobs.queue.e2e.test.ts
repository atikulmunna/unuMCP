import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

// Opt-in: only runs when REDIS_URL is provided (a real broker). The default
// suite (no REDIS_URL) skips this; CI/dev prove the queue by setting REDIS_URL.
const REDIS = process.env.REDIS_URL;

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Q", version: "1.0.0" },
  servers: [{ url: "https://api.q.test" }],
  paths: {
    "/things/{id}": {
      get: {
        operationId: "getThing",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
});

describe.skipIf(!REDIS)("background queue round-trip (P6-6, requires Redis)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const emails: string[] = [];

  beforeAll(async () => {
    // Force the durable queue even though the suite default is inline.
    delete process.env.JOBS_INLINE;
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
    process.env.JOBS_INLINE = "true";
  });

  it("enqueues generation and a worker drives it to passed", async () => {
    const email = `queue-${Date.now()}@example.com`;
    emails.push(email);
    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password: "password123" });
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };

    const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Q" });
    const projectId = project.body.id;
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/spec/upload`)
      .set(auth)
      .send({ filename: "q.json", content: spec });
    await request(app.getHttpServer()).post(`/projects/${projectId}/tools/propose`).set(auth);
    await request(app.getHttpServer()).post(`/projects/${projectId}/tools/approve`).set(auth);

    // Enqueue — returns a queued handle, not the result.
    const enq = await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);
    expect(enq.status).toBe(200);
    expect(enq.body.status).toBe("queued");
    expect(enq.body.jobId).toBeTruthy();

    // Poll until the worker finishes the run.
    let status = "";
    for (let i = 0; i < 40; i++) {
      const latest = await request(app.getHttpServer()).get(`/projects/${projectId}/generation`).set(auth);
      status = latest.body?.run?.status ?? "";
      if (status === "passed" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(status).toBe("passed");

    const latest = await request(app.getHttpServer()).get(`/projects/${projectId}/generation`).set(auth);
    expect(latest.body.artifacts.length).toBeGreaterThan(0);
  });
});
