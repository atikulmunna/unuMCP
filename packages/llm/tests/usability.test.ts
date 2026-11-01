import { describe, expect, it } from "vitest";
import { chooseTool, proposeFixes, writeTasks } from "../src/usability";
import type { LlmClient, LlmCompletion, LlmRequest } from "../src/types";

/** A canned client returning `text` (or throwing) and recording each request. */
function fakeClient(text: string | Error): { client: LlmClient; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  const client: LlmClient = {
    complete(request: LlmRequest): Promise<LlmCompletion> {
      seen.push(request);
      if (text instanceof Error) return Promise.reject(text);
      return Promise.resolve({ text, model: "claude-haiku-4-5", usage: { inputTokens: 300, outputTokens: 60 }, latencyMs: 4 });
    },
  };
  return { client, seen };
}

const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const getWidget = { name: "get_widget", description: "Returns one widget by id.", inputSchema: schema, endpoint: "GET /widgets/{id}" };
const listWidgets = { name: "list_widgets", description: "Lists widgets.", inputSchema: { type: "object", properties: {} }, endpoint: "GET /widgets" };

function expectGuarded(request: LlmRequest) {
  expect(request.temperature).toBe(0);
  expect(request.json).toBe(true);
  expect(request.messages[0]!.content).toMatch(/untrusted/i);
}

describe("writeTasks", () => {
  it("writes one task per tool in one call, aligned by tool name", async () => {
    const { client, seen } = fakeClient(
      JSON.stringify({
        tasks: [
          { tool: "list_widgets", request: "What widgets do we have?", arguments: {} },
          { tool: "get_widget", request: "Show me widget w-7.", arguments: { id: "w-7" } },
        ],
      }),
    );
    const result = await writeTasks(client, [getWidget, listWidgets]);
    expect(seen).toHaveLength(1);
    expectGuarded(seen[0]!);
    expect(seen[0]!.messages[1]!.content).toContain("get_widget");
    // The writer sees each endpoint, and is told to write a request only that one fulfils.
    expect(seen[0]!.messages[1]!.content).toContain("GET /widgets/{id}");
    expect(seen[0]!.messages[0]!.content).toMatch(/only this tool's endpoint fulfils/);
    expect(result.value).toEqual([
      { toolName: "get_widget", prompt: "Show me widget w-7.", expectedArgs: { id: "w-7" } },
      { toolName: "list_widgets", prompt: "What widgets do we have?", expectedArgs: {} },
    ]);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 60 });
  });

  it("drops a task that names its tool, one for a tool not asked about, and a malformed one", async () => {
    const { client } = fakeClient(
      JSON.stringify({
        tasks: [
          { tool: "get_widget", request: "Call get_widget for w-7.", arguments: { id: "w-7" } },
          { tool: "list_widgets", request: "Use the list widgets tool.", arguments: {} },
          { tool: "delete_widget", request: "Delete widget w-7.", arguments: { id: "w-7" } },
          { tool: "get_widget", arguments: { id: "w-8" } },
        ],
      }),
    );
    expect((await writeTasks(client, [getWidget, listWidgets])).value).toEqual([]);
  });

  it("rejects output that is not JSON, since there is nothing to check without tasks", async () => {
    const { client } = fakeClient("Here are some tasks: ...");
    await expect(writeTasks(client, [getWidget])).rejects.toThrow(/JSON/);
  });
});

describe("chooseTool", () => {
  it("shows the candidates and the request, and parses the chosen call", async () => {
    const { client, seen } = fakeClient('```json\n{"tool": "get_widget", "arguments": {"id": "w-7"}}\n```');
    const result = await chooseTool(client, "Show me widget w-7.", [getWidget, listWidgets]);
    expectGuarded(seen[0]!);
    const user = seen[0]!.messages[1]!.content;
    expect(user).toContain("Show me widget w-7.");
    expect(user).toContain("Returns one widget by id.");
    expect(result.value).toEqual({ tool: "get_widget", arguments: { id: "w-7" } });
  });

  it("returns no answer for unreadable output instead of throwing", async () => {
    for (const text of ["I would use get_widget.", '{"arguments": {}}', '{"tool": "get_widget", "arguments": "id=7"}']) {
      const { client } = fakeClient(text);
      expect((await chooseTool(client, "Show me widget w-7.", [getWidget])).value).toBeNull();
    }
  });

  it("lets a provider error through, so the caller can count it", async () => {
    const { client } = fakeClient(new Error("Anthropic request failed (529)"));
    await expect(chooseTool(client, "Show me widget w-7.", [getWidget])).rejects.toThrow(/529/);
  });
});

describe("proposeFixes", () => {
  const miss = {
    toolName: "get_widget",
    endpoint: "GET /widgets/{id}",
    description: "Returns one widget by id.",
    inputSchema: schema,
    misses: [
      { request: "Show me widget w-7.", picked: { name: "list_widgets", description: "Lists widgets." } },
      { request: "Get widget 9.", problem: "id should be \"9\", got null." },
    ],
  };

  it("sends every miss for a tool and returns its revised text", async () => {
    const { client, seen } = fakeClient(
      JSON.stringify({ fixes: [{ tool: "get_widget", description: "Returns a single widget, given its id. To list several, use list_widgets." }] }),
    );
    const result = await proposeFixes(client, [miss]);
    expectGuarded(seen[0]!);
    const user = seen[0]!.messages[1]!.content;
    expect(user).toContain("list_widgets");
    expect(user).toContain("Get widget 9.");
    expect(result.value.get("get_widget")).toEqual({
      description: "Returns a single widget, given its id. To list several, use list_widgets.",
    });
  });

  it("sends each tool's endpoint and the requests wrongly sent to it, so a confused pair is rewritten together", async () => {
    const picked = {
      toolName: "list_widgets",
      endpoint: "GET /widgets",
      description: "Lists widgets.",
      inputSchema: { type: "object", properties: {} },
      misses: [],
      chosenInstead: [{ request: "Show me widget w-7.", intended: "get_widget" }],
    };
    const { client, seen } = fakeClient(
      JSON.stringify({
        fixes: [
          { tool: "get_widget", description: "Returns one widget, given its id." },
          { tool: "list_widgets", description: "Lists every widget; for one widget by id, use get_widget." },
        ],
      }),
    );
    const fixes = (await proposeFixes(client, [miss, picked])).value;
    const sent = JSON.parse(seen[0]!.messages[1]!.content.split("(JSON):\n")[1]!);
    expect(sent[0]).toMatchObject({ toolName: "get_widget", endpoint: "GET /widgets/{id}", inputSchema: schema });
    expect(sent[1]).toMatchObject({ toolName: "list_widgets", chosenInstead: [{ request: "Show me widget w-7.", intended: "get_widget" }] });
    expect(seen[0]!.messages[0]!.content).toMatch(/rewrite every one of them/);
    expect([...fixes.keys()]).toEqual(["get_widget", "list_widgets"]);
  });

  it("keeps a well-formed new name and drops a malformed or unchanged one", async () => {
    const { client } = fakeClient(
      JSON.stringify({
        fixes: [
          { tool: "get_widget", description: "Returns one widget.", name: "get_widget_by_id" },
          { tool: "list_widgets", description: "Lists all widgets.", name: "List Widgets!" },
          { tool: "other", description: "Something.", name: "other" },
        ],
      }),
    );
    const fixes = (await proposeFixes(client, [miss, { ...miss, toolName: "list_widgets" }, { ...miss, toolName: "other" }])).value;
    expect(fixes.get("get_widget")).toEqual({ description: "Returns one widget.", name: "get_widget_by_id" });
    expect(fixes.get("list_widgets")).toEqual({ description: "Lists all widgets." });
    expect(fixes.get("other")).toEqual({ description: "Something." });
  });

  it("rejects secret-shaped or overlong text, and fixes for tools it was not asked about", async () => {
    const { client } = fakeClient(
      JSON.stringify({
        fixes: [
          { tool: "get_widget", description: "Use token ghp_0123456789abcdefghijklmnopqrstuvwx to call it." },
          { tool: "list_widgets", description: "x".repeat(601) },
          { tool: "delete_widget", description: "Deletes a widget." },
        ],
      }),
    );
    const fixes = (await proposeFixes(client, [miss, { ...miss, toolName: "list_widgets" }])).value;
    expect(fixes.size).toBe(0);
  });
});
