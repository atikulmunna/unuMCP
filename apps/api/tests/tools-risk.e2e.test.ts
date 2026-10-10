import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { LlmClient } from "@unumcp/llm";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmService } from "../src/llm/llm.service";

// A fake LLM that rates by HTTP method: it calls the POST critical (the rules
// say medium) and tries to call the DELETE low (the rules say high).
const RATING: Record<string, string> = { GET: "low", POST: "critical", DELETE: "low" };
const fakeClient: LlmClient = {
  complete: async (req) => {
    const userMsg = req.messages.find((m) => m.role === "user")?.content ?? "";
    const facts = JSON.parse(userMsg.slice(userMsg.indexOf("["))) as { toolName: string; method: string }[];
    const descriptions = facts.map((f) => ({
      name: f.toolName,
      description: `Calls ${f.method} on widgets.`,
      risk: RATING[f.method],
    }));
    return {
      text: JSON.stringify({ descriptions }),
      model: "m",
      usage: { inputTokens: 10, outputTokens: 10 },
      latencyMs: 1,
    };
  },
};

const ok = { "200": { description: "ok" } };
const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Widgets", version: "1.0.0" },
  servers: [{ url: "https://api.widgets.test" }],
  paths: {
    "/widgets": {
      post: {
        operationId: "createWidget",
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } },
        },
        responses: ok,
      },
    },
    "/widgets/{id}": {
      get: { operationId: "getWidget", parameters: idParam, responses: ok },
      delete: { operationId: "deleteWidget", parameters: idParam, responses: ok },
    },
  },
});

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LlmService)
    .useValue(new LlmService({ enabled: true, model: "m", apiKey: "k" }, fakeClient))
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

describe("the model's risk rating (second opinion)", () => {
  it("can raise a tool's risk and disable it, but never lowers it", async () => {
    const email = `risk-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    emails.push(email);
    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password: "password123" });
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Risk" });
    const projectId = project.body.id;
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/spec/upload`)
      .set(auth)
      .send({ filename: "widgets.json", content: spec });

    const proposed = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tools/propose`)
      .set(auth);
    expect(proposed.status).toBe(201);
    const byMethod = (m: string) =>
      proposed.body.find((t: { endpoints: { endpoint: { method: string } }[] }) =>
        t.endpoints[0]?.endpoint.method.toUpperCase() === m,
      );

    // Raised from medium to critical, so it starts disabled.
    expect(byMethod("POST")).toMatchObject({ riskLevel: "critical", enabled: false });
    // The model said low; the rules' high stands.
    expect(byMethod("DELETE")).toMatchObject({ riskLevel: "high", enabled: false });
    expect(byMethod("GET")).toMatchObject({ riskLevel: "low", enabled: true });

    const events = await prisma.auditEvent.findMany({ where: { projectId, eventType: "risk_raised" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toMatch(/1 tool\(s\).*\(medium to critical\)/);
    const raised = (events[0]!.metadata as { raised: { from: string; to: string }[] }).raised;
    expect(raised).toEqual([expect.objectContaining({ from: "medium", to: "critical" })]);
  });
});
