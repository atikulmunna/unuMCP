import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { LlmClient } from "@unumcp/llm";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmService } from "../src/llm/llm.service";
import { LlmTraceService } from "../src/llm/llm-trace.service";

// Enabled fake LLM (batch shape, echoes tool names) with fixed usage, so the
// propose stage records real token counts the default LLM_DISABLED suite can't.
const USAGE = { inputTokens: 200, outputTokens: 30 };
const fakeClient: LlmClient = {
  complete: async (req) => {
    const userMsg = req.messages.find((m) => m.role === "user")?.content ?? "";
    const names = [...userMsg.matchAll(/"toolName":\s*"([^"]+)"/g)].map((m) => m[1]);
    return {
      text: JSON.stringify({ descriptions: names.map((name) => ({ name, description: "Lists things. Read-only." })) }),
      model: "gemini-3.5-flash",
      usage: USAGE,
      latencyMs: 5,
    };
  },
};

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Gadgets", version: "1.0.0" },
  servers: [{ url: "https://api.gadgets.test" }],
  paths: {
    "/gadgets": {
      get: {
        operationId: "listGadgets",
        summary: "List gadgets",
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
});

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

async function makeUser(): Promise<string> {
  const email = `cost-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const res = await request(app.getHttpServer()).post("/auth/register").send({ email, password: "password123" });
  return res.body.accessToken;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LlmService)
    .useFactory({
      factory: (p: PrismaService) =>
        new LlmService({ enabled: true, provider: "gemini", model: "gemini-3.5-flash", apiKey: "k" }, fakeClient, new LlmTraceService(p)),
      inject: [PrismaService],
    })
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

describe("LLM token/cost on GenerationRun + metrics (P6-7, NFR-007b)", () => {
  it("attributes proposal tokens to the run and surfaces them in /metrics", async () => {
    const token = await makeUser();
    const auth = { Authorization: `Bearer ${token}` };
    const projectId = (await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Gadgets" })).body.id;
    await request(app.getHttpServer()).post(`/projects/${projectId}/spec/upload`).set(auth).send({ filename: "g.json", content: spec });
    await request(app.getHttpServer()).post(`/projects/${projectId}/tools/propose`).set(auth);
    await request(app.getHttpServer()).post(`/projects/${projectId}/tools/approve`).set(auth);
    await request(app.getHttpServer()).post(`/projects/${projectId}/generation`).set(auth);

    // One endpoint → one batched propose call → its usage lands on the run.
    const run = await prisma.generationRun.findFirstOrThrow({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    expect(run.inputTokens).toBe(USAGE.inputTokens);
    expect(run.outputTokens).toBe(USAGE.outputTokens);
    expect(run.llmModelId).toBe("gemini-3.5-flash");
    expect(Number(run.estimatedCostUsd)).toBe(0); // free tier

    const metrics = await request(app.getHttpServer()).get("/metrics").set(auth);
    expect(metrics.status).toBe(200);
    expect(metrics.body.cost).toEqual({
      totalInputTokens: USAGE.inputTokens,
      totalOutputTokens: USAGE.outputTokens,
      totalEstimatedCostUsd: 0,
    });
  });
});
