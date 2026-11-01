import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ACME_BILLING_RECORDED } from "../src/samples/acme-billing.recorded";

let app: INestApplication;
let prisma: PrismaService;
const emails: string[] = [];

async function signUp(): Promise<{ Authorization: string }> {
  const email = `sample-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password: "password123" });
  return { Authorization: `Bearer ${reg.body.accessToken}` };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  prisma = app.get(PrismaService);
  await app.init();
});

afterAll(async () => {
  for (const email of emails) await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
  await app.close();
});

describe("the sample project", () => {
  it("is ready for review, with the recorded usability check and no LLM calls", async () => {
    const auth = await signUp();
    const server = app.getHttpServer();
    const created = await request(server).post("/projects/sample").set(auth);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sample: "acme-billing", status: "TOOLS_PROPOSED" });
    const id = created.body.id;

    // The real tool plan from the spec: summaries as descriptions, risky actions off.
    const tools = (await request(server).get(`/projects/${id}/tools`).set(auth)).body as {
      name: string;
      description: string;
      riskLevel: string;
      enabled: boolean;
    }[];
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    expect(tool("fetch_invoices").description).toBe("List invoices");
    expect(tool("refund_payment")).toMatchObject({ riskLevel: "high", enabled: false });

    // The recorded check, as recorded, with each fix tied to its tool.
    const { llmEnabled, run } = (await request(server).get(`/projects/${id}/usability`).set(auth)).body;
    expect(llmEnabled).toBe(false);
    expect(run).toMatchObject({
      status: "completed",
      llmModelId: ACME_BILLING_RECORDED.model,
      baselineCorrect: ACME_BILLING_RECORDED.baselineCorrect,
      answeredCount: ACME_BILLING_RECORDED.answeredCount,
      fixedCorrect: ACME_BILLING_RECORDED.fixedCorrect,
    });
    expect(run.tasks).toHaveLength(ACME_BILLING_RECORDED.tasks.length);
    expect(run.fixes).toHaveLength(ACME_BILLING_RECORDED.fixes.length);
    for (const fix of run.fixes) {
      expect(fix.beforeDescription).toBe(tool(fix.toolName).description);
      expect(fix.status).toBe("proposed");
    }

    const audit = (await request(server).get(`/projects/${id}/audit`).set(auth)).body as { eventType: string }[];
    expect(audit.map((e) => e.eventType)).toContain("sample_created");
    expect(audit.some((e) => e.eventType === "llm_tool_call")).toBe(false);
  });

  it("lets you accept a recorded fix with the LLM off", async () => {
    const auth = await signUp();
    const server = app.getHttpServer();
    const id = (await request(server).post("/projects/sample").set(auth)).body.id;
    const { run } = (await request(server).get(`/projects/${id}/usability`).set(auth)).body;
    const fix = run.fixes[0];

    const accepted = await request(server).post(`/projects/${id}/usability/fixes/${fix.id}/accept`).set(auth);
    expect(accepted.status).toBe(200);
    const tools = (await request(server).get(`/projects/${id}/tools`).set(auth)).body as { name: string; description: string }[];
    expect(tools.find((t) => t.name === (fix.afterName ?? fix.toolName))?.description).toBe(fix.afterDescription);
  });

  it("requires sign-in", async () => {
    expect((await request(app.getHttpServer()).post("/projects/sample")).status).toBe(401);
  });
});
