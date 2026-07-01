import { describe, expect, it } from "vitest";
import {
  parseBatchDescriptions,
  parseDescription,
  proposeToolDescription,
  proposeToolDescriptions,
} from "../src/propose";
import type { LlmClient, LlmCompletion, LlmRequest } from "../src/types";

/** A canned client that returns a fixed body and records the request it saw. */
function fakeClient(text: string): { client: LlmClient; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  const client: LlmClient = {
    complete(request: LlmRequest): Promise<LlmCompletion> {
      seen.push(request);
      return Promise.resolve({
        text,
        model: "meta/llama-3.3-70b-instruct",
        usage: { inputTokens: 200, outputTokens: 25 },
        latencyMs: 5,
      });
    },
  };
  return { client, seen };
}

const input = {
  toolName: "create_issue",
  method: "post",
  path: "/repos/{owner}/{repo}/issues",
  summary: "Create an issue",
  paramNames: ["owner", "repo"],
  mutates: true,
  riskLevel: "medium",
};

describe("proposeToolDescription", () => {
  it("sends a deterministic, JSON-mode request carrying the endpoint facts", async () => {
    const { client, seen } = fakeClient('{"description":"Creates a new issue in a repository. Modifies data."}');
    const result = await proposeToolDescription(client, input);

    expect(result.description).toMatch(/creates a new issue/i);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 25 });

    const req = seen[0]!;
    expect(req.temperature).toBe(0);
    expect(req.json).toBe(true);
    // The untrusted-data guard must be present in the system prompt.
    expect(req.messages[0]!.content).toMatch(/untrusted data/i);
    // Facts reach the model.
    expect(req.messages[1]!.content).toContain("/repos/{owner}/{repo}/issues");
    expect(req.messages[1]!.content).toContain("create_issue");
  });

  it("tolerates a model that wraps JSON in ```json fences", async () => {
    const { client } = fakeClient('```json\n{"description":"Fetches a widget by id."}\n```');
    const result = await proposeToolDescription(client, input);
    expect(result.description).toBe("Fetches a widget by id.");
  });

  it("rejects output that is not parseable JSON", async () => {
    const { client } = fakeClient("Sure! Here is the description: create an issue.");
    await expect(proposeToolDescription(client, input)).rejects.toThrow(/JSON/i);
  });

  it("rejects a description that leaks a secret-like token (FR-013)", async () => {
    const { client } = fakeClient(
      '{"description":"Use token ghp_0123456789abcdefghijklmnopqrstuvwx to authenticate."}',
    );
    await expect(proposeToolDescription(client, input)).rejects.toThrow(/secret-like token/i);
  });

  it("parseDescription pulls a bare JSON object out of surrounding text", () => {
    expect(parseDescription('noise {"description":"ok"} trailing')).toBe("ok");
  });
});

const inputs = [
  { toolName: "create_issue", method: "post", path: "/issues", mutates: true, riskLevel: "medium" },
  { toolName: "get_issue", method: "get", path: "/issues/{id}", riskLevel: "low" },
];

describe("proposeToolDescriptions (P2-6, batched)", () => {
  it("describes a whole batch in ONE call and aligns results to input order", async () => {
    const { client, seen } = fakeClient(
      JSON.stringify({
        descriptions: [
          // Deliberately out of order to prove alignment is by name, not position.
          { name: "get_issue", description: "Fetches an issue by id. Read-only." },
          { name: "create_issue", description: "Creates an issue. Modifies data." },
        ],
      }),
    );
    const result = await proposeToolDescriptions(client, inputs);

    expect(seen).toHaveLength(1); // one round-trip for the batch
    expect(result.descriptions[0]).toMatch(/creates an issue/i);
    expect(result.descriptions[1]).toMatch(/fetches an issue/i);
    // Both tools' facts reach the model in the single request.
    expect(seen[0]!.messages[1]!.content).toContain("create_issue");
    expect(seen[0]!.messages[1]!.content).toContain("get_issue");
  });

  it("returns null for a tool the model omitted so the caller can fall back", async () => {
    const { client } = fakeClient(
      JSON.stringify({ descriptions: [{ name: "create_issue", description: "Creates an issue." }] }),
    );
    const result = await proposeToolDescriptions(client, inputs);
    expect(result.descriptions[0]).toMatch(/creates an issue/i);
    expect(result.descriptions[1]).toBeNull(); // get_issue missing → null
  });

  it("nulls out a single secret-shaped description without failing the batch", async () => {
    const { client } = fakeClient(
      JSON.stringify({
        descriptions: [
          { name: "create_issue", description: "Use ghp_0123456789abcdefghijklmnopqrstuvwx here." },
          { name: "get_issue", description: "Fetches an issue by id." },
        ],
      }),
    );
    const result = await proposeToolDescriptions(client, inputs);
    expect(result.descriptions[0]).toBeNull(); // secret dropped
    expect(result.descriptions[1]).toMatch(/fetches an issue/i);
  });

  it("short-circuits an empty batch with no LLM call", async () => {
    const { client, seen } = fakeClient("{}");
    const result = await proposeToolDescriptions(client, []);
    expect(result.descriptions).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("parseBatchDescriptions builds a name→description map and skips malformed rows", () => {
    const map = parseBatchDescriptions(
      '{"descriptions":[{"name":"a","description":"A"},{"name":"b"},{"description":"no name"}]}',
    );
    expect(map.get("a")).toBe("A");
    expect(map.has("b")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("parseBatchDescriptions rejects a response without a descriptions array", () => {
    expect(() => parseBatchDescriptions('{"foo":1}')).toThrow(/descriptions/i);
  });
});
