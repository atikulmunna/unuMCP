import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Gadgets", version: "1.0.0" },
  servers: [{ url: "https://api.gadgets.test" }],
  paths: {
    "/gadgets/{id}": {
      get: {
        operationId: "getGadget",
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

/** upload → propose → approve → generate, leaving one passed GenerationRun. */
async function generatedProject(token: string): Promise<void> {
  const auth = { Authorization: `Bearer ${token}` };
  const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Gadgets" });
  const projectId = project.body.id;
  await request(app.getHttpServer())
    .post(`/projects/${projectId}/spec/upload`)
    .set(auth)
    .send({ filename: "gadgets.json", content: spec });
  await request(app.getHttpServer()).post(`/projects/${projectId}/tools/propose`).set(auth);
  await request(app.getHttpServer()).post(`/projects/${projectId}/tools/approve`).set(auth);
  await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);
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

describe("observability metrics (P6-7, §25)", () => {
  it("requires authentication", async () => {
    const res = await request(app.getHttpServer()).get("/metrics");
    expect(res.status).toBe(401);
  });

  it("reflects the caller's own generation activity", async () => {
    const token = await makeUser("metrics");
    await generatedProject(token);

    const res = await request(app.getHttpServer())
      .get("/metrics")
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.projectsCreated).toBe(1);
    expect(res.body.specsParsed).toBe(1);
    expect(res.body.serversGenerated).toBe(1);
    expect(res.body.generationSuccessRate).toBe(1);
    expect(res.body.cost).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUsd: 0,
    });
  });

  it("is scoped per user — a fresh user sees zeroes", async () => {
    const token = await makeUser("metrics-fresh");
    const res = await request(app.getHttpServer())
      .get("/metrics")
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.projectsCreated).toBe(0);
    expect(res.body.serversGenerated).toBe(0);
    expect(res.body.generationSuccessRate).toBe(0);
  });
});
