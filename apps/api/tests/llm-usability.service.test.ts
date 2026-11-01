import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@unumcp/llm";
import { LlmService } from "../src/llm/llm.service";
import type { LlmTraceEntry, LlmTraceService } from "../src/llm/llm-trace.service";

const tool = { name: "get_widget", description: "Returns one widget.", inputSchema: { type: "object" }, endpoint: "GET /widgets/{id}" };

function reply(text: string): LlmClient {
  return {
    complete: vi.fn(async () => ({ text, model: "claude-haiku-4-5", usage: { inputTokens: 120, outputTokens: 30 }, latencyMs: 2 })),
  };
}

function traced(client: LlmClient) {
  const record = vi.fn(async (_e: LlmTraceEntry) => undefined);
  const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client, { record } as unknown as LlmTraceService);
  return { svc, record };
}

describe("LlmService usability calls", () => {
  it("traces writing tasks", async () => {
    const { svc, record } = traced(
      reply(JSON.stringify({ tasks: [{ tool: "get_widget", request: "Show widget 7.", arguments: { id: "7" } }] })),
    );
    const result = await svc.writeUsabilityTasks([tool], { projectId: "p1" });
    expect(result.value).toHaveLength(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      projectId: "p1",
      toolName: "write_usability_tasks",
      outputSummary: "wrote 1 task(s)",
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it("traces the agent's choice", async () => {
    const { svc, record } = traced(reply('{"tool": "get_widget", "arguments": {"id": "7"}}'));
    const result = await svc.chooseUsabilityTool("Show widget 7.", [tool], { projectId: "p1" });
    expect(result.value).toEqual({ tool: "get_widget", arguments: { id: "7" } });
    expect(record.mock.calls[0]![0]).toMatchObject({ toolName: "choose_tool", outputSummary: "chose get_widget" });
  });

  it("traces proposed fixes", async () => {
    const { svc, record } = traced(reply(JSON.stringify({ fixes: [{ tool: "get_widget", description: "Returns a single widget." }] })));
    const result = await svc.proposeUsabilityFixes(
      [{ toolName: "get_widget", endpoint: "GET /widgets/{id}", description: "Returns one widget.", misses: [{ request: "Show widget 7." }] }],
      { projectId: "p1" },
    );
    expect(result.value.size).toBe(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ toolName: "propose_usability_fixes", outputSummary: "proposed 1 fix(es)" });
  });

  it("traces a provider error and rethrows it for the check to handle", async () => {
    const client: LlmClient = { complete: vi.fn(async () => { throw new Error("provider 529"); }) };
    const { svc, record } = traced(client);
    await expect(svc.chooseUsabilityTool("Show widget 7.", [tool], { projectId: "p1" })).rejects.toThrow(/529/);
    expect(record.mock.calls[0]![0]).toMatchObject({ toolName: "choose_tool", error: expect.stringContaining("529") });
  });

  it("refuses when the LLM is off", async () => {
    const svc = new LlmService({ enabled: false, model: "m" });
    await expect(svc.writeUsabilityTasks([tool])).rejects.toThrow(/disabled/);
  });
});
