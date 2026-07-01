import { describe, expect, it, vi } from "vitest";
import { LlmService } from "../src/llm/llm.service";
import { LlmTraceService, type LlmTraceEntry } from "../src/llm/llm-trace.service";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { LlmClient } from "@unumcp/llm";

interface AuditData {
  projectId: string;
  eventType: string;
  actor: string;
  summary: string;
  metadata: Record<string, unknown>;
}

/** A PrismaService stub that captures the single `auditEvent.create` payload. */
function fakePrisma() {
  const create = vi.fn(async (args: { data: AuditData }) => args.data);
  const prisma = { auditEvent: { create } } as unknown as PrismaService;
  return { prisma, create };
}

const facts = {
  toolName: "create_issue",
  method: "post",
  path: "/repos/{owner}/{repo}/issues",
  paramNames: ["owner", "repo"],
  mutates: true,
  riskLevel: "medium",
};

const GITHUB_PAT = "ghp_" + "A".repeat(36); // token-shaped secret

describe("LlmTraceService (P5-5, FR-031)", () => {
  it("records name, summaries, timestamp fields, and marks status ok", async () => {
    const { prisma, create } = fakePrisma();
    await new LlmTraceService(prisma).record({
      projectId: "p1",
      toolName: "propose_tool_description",
      inputSummary: "POST /issues → create_issue",
      outputSummary: "Creates an issue. Modifies data.",
      latencyMs: 1600,
      inputTokens: 595,
      outputTokens: 30,
    });
    expect(create).toHaveBeenCalledOnce();
    const { data } = create.mock.calls[0]![0];
    expect(data.projectId).toBe("p1");
    expect(data.eventType).toBe("llm_tool_call");
    expect(data.actor).toBe("agent");
    expect(data.metadata).toMatchObject({
      toolName: "propose_tool_description",
      status: "ok",
      inputTokens: 595,
      outputTokens: 30,
      latencyMs: 1600,
    });
  });

  it("redacts secrets from every free-text field (NFR-001)", async () => {
    const { prisma, create } = fakePrisma();
    await new LlmTraceService(prisma).record({
      projectId: "p1",
      toolName: "propose_tool_description",
      inputSummary: `key ${GITHUB_PAT}`,
      outputSummary: `leaked ${GITHUB_PAT}`,
    });
    const blob = JSON.stringify(create.mock.calls[0]![0].data);
    expect(blob).not.toContain(GITHUB_PAT);
    expect(blob).toContain("REDACTED");
  });

  it("records the error and status=error when the call failed", async () => {
    const { prisma, create } = fakePrisma();
    await new LlmTraceService(prisma).record({
      projectId: "p1",
      toolName: "repair_code",
      inputSummary: "1 file(s): src/tools/x.ts",
      error: "Error: NIM request failed (503)",
    });
    const { data } = create.mock.calls[0]![0];
    expect(data.metadata).toMatchObject({ status: "error", error: expect.stringContaining("503") });
    expect(data.metadata.outputSummary).toBeUndefined();
  });

  it("never throws when the DB write fails — a trace must not break the pipeline", async () => {
    const prisma = {
      auditEvent: { create: vi.fn(async () => { throw new Error("db down"); }) },
    } as unknown as PrismaService;
    await expect(
      new LlmTraceService(prisma).record({
        projectId: "p1",
        toolName: "repair_code",
        inputSummary: "x",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("LlmService trace wiring (P5-5, FR-031)", () => {
  const okClient = (): LlmClient => ({
    complete: vi.fn(async () => ({
      text: '{"description":"Creates an issue. Modifies data."}',
      model: "meta/llama-3.3-70b-instruct",
      usage: { inputTokens: 100, outputTokens: 12 },
      latencyMs: 3,
    })),
  });

  it("traces a successful describeTool when a project ctx is given", async () => {
    const record = vi.fn(async (_e: LlmTraceEntry) => undefined);
    const trace = { record } as unknown as LlmTraceService;
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, okClient(), trace);

    await svc.describeTool(facts, { projectId: "p9" });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({
      projectId: "p9",
      toolName: "propose_tool_description",
      outputSummary: expect.stringMatching(/creates an issue/i),
      inputTokens: 100,
    });
  });

  it("does NOT trace when no project ctx is passed (back-compat)", async () => {
    const record = vi.fn(async (_e: LlmTraceEntry) => undefined);
    const trace = { record } as unknown as LlmTraceService;
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, okClient(), trace);
    await svc.describeTool(facts);
    expect(record).not.toHaveBeenCalled();
  });

  it("traces an errored describeTool but still returns null (never throws)", async () => {
    const record = vi.fn(async (_e: LlmTraceEntry) => undefined);
    const trace = { record } as unknown as LlmTraceService;
    const client: LlmClient = {
      complete: vi.fn(async () => { throw new Error("NIM request failed (503)"); }),
    };
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client, trace);

    expect(await svc.describeTool(facts, { projectId: "p9" })).toBeNull();
    expect(record.mock.calls[0]![0]).toMatchObject({
      toolName: "propose_tool_description",
      error: expect.stringContaining("503"),
    });
  });

  it("traces a repair error and rethrows so the orchestrator can stop", async () => {
    const record = vi.fn(async (_e: LlmTraceEntry) => undefined);
    const trace = { record } as unknown as LlmTraceService;
    const client: LlmClient = {
      complete: vi.fn(async () => { throw new Error("boom"); }),
    };
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client, trace);

    await expect(
      svc.repair({ failureLog: "fail", files: [{ path: "src/x.ts", content: "x" }] }, { projectId: "p9" }),
    ).rejects.toThrow();
    expect(record.mock.calls[0]![0]).toMatchObject({ toolName: "repair_code", error: expect.any(String) });
  });
});

describe("LlmService.describeToolsBatch (P2-6, FR-031)", () => {
  const batchClient = (): LlmClient => ({
    complete: vi.fn(async () => ({
      text: JSON.stringify({
        descriptions: [
          { name: "create_issue", description: "Creates an issue. Modifies data." },
          { name: "get_issue", description: "Fetches an issue by id." },
        ],
      }),
      model: "meta/llama-3.3-70b-instruct",
      usage: { inputTokens: 300, outputTokens: 40 },
      latencyMs: 9,
    })),
  });

  const twoInputs = [
    { toolName: "create_issue", method: "post", path: "/issues", mutates: true, riskLevel: "medium" },
    { toolName: "get_issue", method: "get", path: "/issues/{id}", riskLevel: "low" },
  ];

  it("returns aligned descriptions and traces one batch call", async () => {
    const record = vi.fn(async (_e: LlmTraceEntry) => undefined);
    const trace = { record } as unknown as LlmTraceService;
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, batchClient(), trace);

    const out = await svc.describeToolsBatch(twoInputs, { projectId: "p9" });
    expect(out[0]).toMatch(/creates an issue/i);
    expect(out[1]).toMatch(/fetches an issue/i);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({
      toolName: "propose_tool_descriptions_batch",
      outputSummary: "described 2/2 tool(s)",
      inputTokens: 300,
    });
  });

  it("returns all-null (never throws) and traces an error when the provider fails", async () => {
    const record = vi.fn(async (_e: LlmTraceEntry) => undefined);
    const trace = { record } as unknown as LlmTraceService;
    const client: LlmClient = { complete: vi.fn(async () => { throw new Error("NIM 503"); }) };
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client, trace);

    const out = await svc.describeToolsBatch(twoInputs, { projectId: "p9" });
    expect(out).toEqual([null, null]);
    expect(record.mock.calls[0]![0]).toMatchObject({
      toolName: "propose_tool_descriptions_batch",
      error: expect.stringContaining("503"),
    });
  });

  it("returns all-null when disabled, and empty for an empty batch", async () => {
    const disabled = new LlmService({ enabled: false, model: "m" });
    expect(await disabled.describeToolsBatch(twoInputs)).toEqual([null, null]);
    const enabled = new LlmService({ enabled: true, model: "m", apiKey: "k" }, batchClient());
    expect(await enabled.describeToolsBatch([])).toEqual([]);
  });
});
