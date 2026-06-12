import { describe, expect, it } from "vitest";
import { parseDescription, proposeToolDescription } from "../src/propose";
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
