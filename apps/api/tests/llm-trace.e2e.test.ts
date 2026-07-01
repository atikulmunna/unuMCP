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

// A fake, always-enabled LLM client so the propose path really runs the LLM
// stage (the default suite runs LLM_DISABLED=true, where there are no internal
// tool calls to trace). It echoes the batch shape (P2-6), describing every
// toolName it finds in the request with a benign, FR-013-clean description.
const fakeClient: LlmClient = {
  complete: async (req) => {
    const userMsg = req.messages.find((m) => m.role === "user")?.content ?? "";
    const names = [...userMsg.matchAll(/"toolName":\s*"([^"]+)"/g)].map((m) => m[1]);
    const descriptions = names.map((name) => ({
      name,
      description: "Fetches a widget by id. Read-only, does not modify data.",
    }));
    return {
      text: JSON.stringify({ descriptions }),
      model: "meta/llama-3.3-70b-instruct",
      usage: { inputTokens: 120, outputTokens: 14 },
      latencyMs: 7,
    };
  },
};

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Widgets", version: "1.0.0" },
  servers: [{ url: "https://api.widgets.test" }],
  paths: {
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        summary: "Get one widget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } },
          },
        },
      },
    },
  },
});

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

async function makeUser(): Promise<string> {
  const email = `trace-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const res = await request(app.getHttpServer())
    .post("/auth/register")
    .send({ email, password: "password123" });
  return res.body.accessToken;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LlmService)
    .useFactory({
      factory: (p: PrismaService) =>
        new LlmService({ enabled: true, model: "m", apiKey: "k" }, fakeClient, new LlmTraceService(p)),
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

describe("internal agent tool-call trace (P5-5, FR-031)", () => {
  it("records an llm_tool_call trace per proposed tool, visible in the audit trail", async () => {
    const token = await makeUser();
    const auth = { Authorization: `Bearer ${token}` };
    const project = await request(app.getHttpServer()).post("/projects").set(auth).send({ name: "Trace" });
    const projectId = project.body.id;
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/spec/upload`)
      .set(auth)
      .send({ filename: "widgets.json", content: spec });

    const proposed = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tools/propose`)
      .set(auth);
    expect(proposed.status).toBe(201);
    expect(proposed.body).toHaveLength(1);
    // The LLM-authored description made it onto the tool.
    expect(proposed.body[0].description).toMatch(/fetches a widget/i);

    // The internal call was traced (FR-031: name, summaries, timestamp, secrets redacted).
    // One endpoint fits in a single batch → one traced batch call.
    const traces = await prisma.auditEvent.findMany({
      where: { projectId, eventType: "llm_tool_call" },
    });
    expect(traces).toHaveLength(1);
    const meta = traces[0]!.metadata as Record<string, unknown>;
    expect(traces[0]!.actor).toBe("agent");
    expect(meta.toolName).toBe("propose_tool_descriptions_batch");
    expect(meta.status).toBe("ok");
    expect(String(meta.inputSummary)).toMatch(/1 tool\(s\)/);
    expect(String(meta.outputSummary)).toBe("described 1/1 tool(s)");
    expect(meta.inputTokens).toBe(120);
    expect(meta.outputTokens).toBe(14);

    // And it surfaces through the ownership-guarded audit endpoint.
    const audit = await request(app.getHttpServer()).get(`/projects/${projectId}/audit`).set(auth);
    expect(audit.status).toBe(200);
    expect(audit.body.some((e: { eventType: string }) => e.eventType === "llm_tool_call")).toBe(true);
  });
});
