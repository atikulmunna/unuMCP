import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { LlmClient } from "@unumcp/llm";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmService } from "../src/llm/llm.service";
import { LlmTraceService } from "../src/llm/llm-trace.service";
import { UsabilityService } from "../src/usability/usability.service";
import { ToolsService } from "../src/tools/tools.service";

interface ToolText {
  name: string;
  description: string;
}
type Choice = { tool: string; arguments: Record<string, unknown> } | "unreadable" | "error";

/** What the scripted model does; each test adjusts it. */
interface Script {
  agent: (request: string, tools: ToolText[]) => Choice;
  fixes: Record<string, { description: string; name?: string }> | "error";
}

const TASKS: Record<string, { request: string; args: Record<string, unknown> }> = {
  list_widgets: { request: "What widgets do we have?", args: {} },
  get_widget: { request: "Show me widget 7.", args: { id: "7" } },
  create_widget: { request: "Make a widget called Bolt.", args: { body: { name: "Bolt" } } },
  list_gadgets: { request: "Which gadgets exist?", args: {} },
};

const has = (tools: ToolText[], name: string, words: string) =>
  tools.some((t) => t.name === name && t.description.toLowerCase().includes(words));

/**
 * The default agent: right every time, except that it reads "widget 7" as a
 * list unless get_widget says it returns a single widget.
 */
function defaultAgent(request: string, tools: ToolText[]): Choice {
  if (request.includes("widget 7")) {
    return has(tools, "get_widget", "single")
      ? { tool: "get_widget", arguments: { id: "7" } }
      : { tool: "list_widgets", arguments: {} };
  }
  if (request.includes("Bolt")) return { tool: "create_widget", arguments: { body: { name: "Bolt" } } };
  if (request.includes("gadgets")) return { tool: "list_gadgets", arguments: {} };
  return { tool: "list_widgets", arguments: {} };
}

let script: Script;
const resetScript = () => {
  script = { agent: defaultAgent, fixes: { get_widget: { description: "Returns a single widget, given its id." } } };
};

const after = (text: string, marker: string) => text.slice(text.indexOf(marker) + marker.length);
const fakeClient: LlmClient = {
  complete: async (req) => {
    const system = req.messages[0]!.content;
    const user = req.messages[1]!.content;
    const reply = (value: unknown) => ({
      text: typeof value === "string" ? value : JSON.stringify(value),
      model: "claude-haiku-4-5",
      usage: { inputTokens: 100, outputTokens: 20 },
      latencyMs: 1,
    });
    if (system.includes("concise, accurate descriptions")) return reply({ descriptions: [] });
    if (system.includes("You write realistic requests")) {
      const tools = JSON.parse(after(user, "Tools (JSON):\n")) as ToolText[];
      return reply({ tasks: tools.map((t) => ({ tool: t.name, request: TASKS[t.name]!.request, arguments: TASKS[t.name]!.args })) });
    }
    if (system.includes("You are an AI assistant")) {
      const tools = JSON.parse(after(user, "Tools (JSON):\n").split("\n\nUser request:\n")[0]!) as ToolText[];
      const choice = script.agent(after(user, "User request:\n"), tools);
      if (choice === "error") throw new Error("provider 529");
      return reply(choice === "unreadable" ? "I would use the first one." : choice);
    }
    if (system.includes("You improve MCP tool descriptions")) {
      if (script.fixes === "error") throw new Error("provider 529");
      const fixes = script.fixes;
      const requests = JSON.parse(after(user, "(JSON):\n")) as { toolName: string }[];
      return reply({ fixes: requests.filter((r) => fixes[r.toolName]).map((r) => ({ tool: r.toolName, ...fixes[r.toolName] })) });
    }
    throw new Error(`Unexpected prompt: ${system.slice(0, 80)}`);
  },
};

const ok = { "200": { description: "ok" } };
const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Widgets", version: "1.0.0" },
  servers: [{ url: "https://api.widgets.test" }],
  paths: {
    "/widgets": {
      get: { operationId: "listWidgets", summary: "List widgets", responses: ok },
      post: {
        operationId: "createWidget",
        summary: "Create a widget",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
        },
        responses: ok,
      },
    },
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        summary: "Get a widget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: ok,
      },
    },
    "/gadgets": { get: { operationId: "listGadgets", summary: "List gadgets", responses: ok } },
  },
});

let app: INestApplication;
let prisma: PrismaService;
let llm: LlmService;
const emails: string[] = [];

async function projectWithTools(): Promise<{ projectId: string; auth: { Authorization: string } }> {
  const email = `usability-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emails.push(email);
  const server = app.getHttpServer();
  const reg = await request(server).post("/auth/register").send({ email, password: "password123" });
  const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
  const project = await request(server).post("/projects").set(auth).send({ name: "Widgets" });
  await request(server).post(`/projects/${project.body.id}/spec/upload`).set(auth).send({ filename: "w.json", content: spec });
  await request(server).post(`/projects/${project.body.id}/tools/propose`).set(auth);
  return { projectId: project.body.id, auth };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LlmService)
    .useFactory({
      factory: (p: PrismaService) =>
        new LlmService({ enabled: true, model: "claude-haiku-4-5", apiKey: "k" }, fakeClient, new LlmTraceService(p)),
      inject: [PrismaService],
    })
    .compile();
  app = moduleRef.createNestApplication();
  prisma = app.get(PrismaService);
  llm = app.get(LlmService);
  await app.init();
});

beforeEach(resetScript);

afterAll(async () => {
  for (const email of emails) {
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  await app.close();
});

const service = (maxCalls = 150) =>
  new UsabilityService(prisma, llm, app.get(ToolsService), { maxTasks: 40, concurrency: 2, maxCalls });

describe("the usability check", () => {
  it("finds a confused tool, offers a fix that re-scores as a hit, and records cost", async () => {
    const { projectId } = await projectWithTools();
    const result = await service().runCheck(projectId);
    expect(result).toMatchObject({ status: "completed", taskCount: 4, answeredCount: 4, baselineCorrect: 3, fixedCorrect: 4 });

    const run = await prisma.usabilityRun.findUniqueOrThrow({
      where: { id: result.runId },
      include: { tasks: true, fixes: true },
    });
    const missed = run.tasks.find((t) => t.toolName === "get_widget")!;
    expect(missed).toMatchObject({ outcome: "wrong_tool", chosenTool: "list_widgets" });
    expect(run.fixes).toHaveLength(1);
    expect(run.fixes[0]).toMatchObject({
      toolName: "get_widget",
      afterDescription: "Returns a single widget, given its id.",
      missesFixed: 1,
      status: "proposed",
    });
    // 1 task-writing + 4 baseline + 1 fix + 4 re-scored calls, at 100 in / 20 out each.
    expect(run).toMatchObject({ inputTokens: 1000, outputTokens: 200, llmModelId: "claude-haiku-4-5" });
    expect(Number(run.estimatedCostUsd)).toBe(0.002);
    // Every one of the check's calls is traced (proposing tools made one more, earlier).
    const traces = await prisma.auditEvent.findMany({ where: { projectId, eventType: "llm_tool_call" } });
    const checkCalls = ["write_usability_tasks", "choose_tool", "propose_usability_fixes"];
    expect(traces.filter((t) => checkCalls.includes((t.metadata as { toolName: string }).toolName))).toHaveLength(10);
    const checked = await prisma.auditEvent.findFirstOrThrow({ where: { projectId, eventType: "usability_checked" } });
    expect(checked.summary).toMatch(/3 of 4.*4 of 4/);
  });

  it("drops a fix that turns another tool's hit into a miss, and re-scores without it", async () => {
    const { projectId } = await projectWithTools();
    script.agent = (request, tools) => {
      // Gadgets are only found when list_gadgets says it lists every gadget...
      if (request.includes("gadgets")) {
        return has(tools, "list_gadgets", "every gadget")
          ? { tool: "list_gadgets", arguments: {} }
          : { tool: "list_widgets", arguments: {} };
      }
      // ...but once it also claims widgets, the widget question goes there.
      if (request.includes("What widgets") && has(tools, "list_gadgets", "and widget")) {
        return { tool: "list_gadgets", arguments: {} };
      }
      return defaultAgent(request, tools);
    };
    script.fixes = {
      get_widget: { description: "Returns a single widget, given its id." },
      list_gadgets: { description: "Lists every gadget and widget." },
    };
    const result = await service().runCheck(projectId);
    expect(result).toMatchObject({ status: "completed", baselineCorrect: 2, fixedCorrect: 3 });
    const fixes = await prisma.usabilityFix.findMany({ where: { runId: result.runId } });
    expect(fixes.map((f) => f.toolName)).toEqual(["get_widget"]);
  });

  it("fails the run when more than a quarter of the tasks get no answer", async () => {
    const { projectId } = await projectWithTools();
    script.agent = (request, tools) =>
      request.includes("widget 7") || request.includes("Bolt") ? "unreadable" : defaultAgent(request, tools);
    const result = await service().runCheck(projectId);
    expect(result.status).toBe("failed");
    const run = await prisma.usabilityRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run.errorMessage).toMatch(/2 of 4 tasks got no answer/);
  });

  it("still completes with the baseline when proposing fixes fails", async () => {
    const { projectId } = await projectWithTools();
    script.fixes = "error";
    const result = await service().runCheck(projectId);
    expect(result).toMatchObject({ status: "completed", baselineCorrect: 3, fixedCorrect: null });
    const run = await prisma.usabilityRun.findUniqueOrThrow({ where: { id: result.runId }, include: { fixes: true } });
    expect(run.fixes).toHaveLength(0);
    expect(run.note).toMatch(/fixes could not be proposed/i);
  });

  it("stops at the call ceiling", async () => {
    const { projectId } = await projectWithTools();
    const result = await service(3).runCheck(projectId);
    expect(result.status).toBe("failed");
    const run = await prisma.usabilityRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run.errorMessage).toMatch(/limit of 3 LLM calls/);
    // The calls made before stopping are still paid for and recorded.
    expect(run.inputTokens).toBe(300);
  });
});

describe("usability endpoints", () => {
  const server = () => app.getHttpServer();
  const toolNamed = (projectId: string, name: string) =>
    prisma.toolCandidate.findFirstOrThrow({ where: { projectId, name } });

  it("runs a check inline and returns it with its tasks and fixes", async () => {
    const { projectId, auth } = await projectWithTools();
    const started = await request(server()).post(`/projects/${projectId}/usability`).set(auth);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: "completed", baselineCorrect: 3, fixedCorrect: 4 });

    const latest = await request(server()).get(`/projects/${projectId}/usability`).set(auth);
    expect(latest.status).toBe(200);
    expect(latest.body.llmEnabled).toBe(true);
    expect(latest.body.run).toMatchObject({ id: started.body.runId, status: "completed" });
    expect(latest.body.run.tasks).toHaveLength(4);
    expect(latest.body.run.fixes).toHaveLength(1);
  });

  it("refuses a check without the LLM, with fewer than two tools, while one runs, or after approval", async () => {
    const { projectId, auth } = await projectWithTools();
    const noLlm = new UsabilityService(prisma, new LlmService({ enabled: false, model: "m" }), app.get(ToolsService), {
      maxTasks: 40,
      concurrency: 2,
      maxCalls: 150,
    });
    await expect(noLlm.assertCanStart(projectId)).rejects.toMatchObject({ status: 400 });

    const running = await prisma.usabilityRun.create({ data: { projectId } });
    expect((await request(server()).post(`/projects/${projectId}/usability`).set(auth)).status).toBe(409);
    await prisma.usabilityRun.delete({ where: { id: running.id } });

    for (const name of ["list_widgets", "create_widget", "list_gadgets"]) {
      const tool = await toolNamed(projectId, name);
      await request(server()).patch(`/projects/${projectId}/tools/${tool.id}`).set(auth).send({ enabled: false });
    }
    expect((await request(server()).post(`/projects/${projectId}/usability`).set(auth)).status).toBe(400);

    const other = await projectWithTools();
    await request(server()).post(`/projects/${other.projectId}/tools/approve`).set(other.auth);
    expect((await request(server()).post(`/projects/${other.projectId}/usability`).set(other.auth)).status).toBe(409);
  });

  it("accepts a fix: the tool takes its text and the decision is audited", async () => {
    const { projectId, auth } = await projectWithTools();
    const { runId } = (await request(server()).post(`/projects/${projectId}/usability`).set(auth)).body;
    const fix = await prisma.usabilityFix.findFirstOrThrow({ where: { runId } });

    const accepted = await request(server()).post(`/projects/${projectId}/usability/fixes/${fix.id}/accept`).set(auth);
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("accepted");
    expect((await toolNamed(projectId, "get_widget")).description).toBe("Returns a single widget, given its id.");
    expect(await prisma.auditEvent.count({ where: { projectId, eventType: "usability_fix_accepted" } })).toBe(1);

    // A decision is final.
    const again = await request(server()).post(`/projects/${projectId}/usability/fixes/${fix.id}/reject`).set(auth);
    expect(again.status).toBe(409);
  });

  it("refuses a rename that clashes with another tool, leaving the fix open", async () => {
    const { projectId, auth } = await projectWithTools();
    const { runId } = (await request(server()).post(`/projects/${projectId}/usability`).set(auth)).body;
    const fix = await prisma.usabilityFix.update({
      where: { id: (await prisma.usabilityFix.findFirstOrThrow({ where: { runId } })).id },
      data: { afterName: "list_widgets" },
    });
    const res = await request(server()).post(`/projects/${projectId}/usability/fixes/${fix.id}/accept`).set(auth);
    expect(res.status).toBe(409);
    expect((await prisma.usabilityFix.findUniqueOrThrow({ where: { id: fix.id } })).status).toBe("proposed");
  });

  it("marks a fix stale when the tool changed since the check", async () => {
    const { projectId, auth } = await projectWithTools();
    const { runId } = (await request(server()).post(`/projects/${projectId}/usability`).set(auth)).body;
    const fix = await prisma.usabilityFix.findFirstOrThrow({ where: { runId } });
    const tool = await toolNamed(projectId, "get_widget");
    await request(server()).patch(`/projects/${projectId}/tools/${tool.id}`).set(auth).send({ description: "Edited by hand." });

    const res = await request(server()).post(`/projects/${projectId}/usability/fixes/${fix.id}/accept`).set(auth);
    expect(res.status).toBe(409);
    expect((await prisma.usabilityFix.findUniqueOrThrow({ where: { id: fix.id } })).status).toBe("stale");
    expect((await toolNamed(projectId, "get_widget")).description).toBe("Edited by hand.");
  });

  it("rejects a fix and audits it", async () => {
    const { projectId, auth } = await projectWithTools();
    const { runId } = (await request(server()).post(`/projects/${projectId}/usability`).set(auth)).body;
    const fix = await prisma.usabilityFix.findFirstOrThrow({ where: { runId } });
    const res = await request(server()).post(`/projects/${projectId}/usability/fixes/${fix.id}/reject`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(await prisma.auditEvent.count({ where: { projectId, eventType: "usability_fix_rejected" } })).toBe(1);
    expect((await toolNamed(projectId, "get_widget")).description).not.toMatch(/single/);
  });

  it("hides one user's checks and fixes from another", async () => {
    const owner = await projectWithTools();
    const { runId } = (await request(server()).post(`/projects/${owner.projectId}/usability`).set(owner.auth)).body;
    const fix = await prisma.usabilityFix.findFirstOrThrow({ where: { runId } });
    const stranger = await projectWithTools();
    const base = `/projects/${owner.projectId}/usability`;
    expect((await request(server()).get(base).set(stranger.auth)).status).toBe(404);
    expect((await request(server()).post(base).set(stranger.auth)).status).toBe(404);
    expect((await request(server()).post(`${base}/fixes/${fix.id}/accept`).set(stranger.auth)).status).toBe(404);
    // A fix id from another project is not found under the stranger's own project either.
    const own = `/projects/${stranger.projectId}/usability/fixes/${fix.id}/reject`;
    expect((await request(server()).post(own).set(stranger.auth)).status).toBe(404);
  });
});
