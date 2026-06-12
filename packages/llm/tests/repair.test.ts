import { describe, expect, it } from "vitest";
import { parseRepairFiles, repairCode } from "../src/repair";
import type { LlmClient, LlmCompletion, LlmRequest } from "../src/types";

function fakeClient(text: string): { client: LlmClient; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  const client: LlmClient = {
    complete(request: LlmRequest): Promise<LlmCompletion> {
      seen.push(request);
      return Promise.resolve({
        text,
        model: "qwen/qwen2.5-coder-32b-instruct",
        usage: { inputTokens: 400, outputTokens: 120 },
        latencyMs: 9,
      });
    },
  };
  return { client, seen };
}

const brokenFile = {
  path: "src/client/apiClient.ts",
  content: "export const x = 1; // if (response.ok) throw — bug here\n",
};

const goodResponse = [
  "<<<FILE: src/client/apiClient.ts>>>",
  "```ts",
  "export const x = 1; // fixed: if (!response.ok) throw",
  "```",
].join("\n");

describe("repairCode", () => {
  it("returns the corrected file and feeds the failure log + file into the prompt", async () => {
    const { client, seen } = fakeClient(goodResponse);
    const result = await repairCode(client, {
      failureLog: "FAIL tests/createIssue.test.ts > throws on a non-2xx response",
      files: [brokenFile],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("src/client/apiClient.ts");
    expect(result.files[0]!.content).toContain("if (!response.ok) throw");
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 120 });

    const user = seen[0]!.messages[1]!.content;
    expect(user).toContain("throws on a non-2xx response"); // failure signal
    expect(user).toContain("src/client/apiClient.ts"); // file under repair
    // Tests are frozen — the system prompt must forbid editing them.
    expect(seen[0]!.messages[0]!.content).toMatch(/never modify.*test/i);
  });

  it("refuses a repair that tries to edit a frozen test file", () => {
    const malicious = "<<<FILE: tests/createIssue.test.ts>>>\n```ts\nit.skip('x',()=>{})\n```";
    expect(() => parseRepairFiles(malicious, new Set(["src/client/apiClient.ts"]))).toThrow(
      /frozen test file/i,
    );
  });

  it("refuses a file outside the editable set", () => {
    const escape = "<<<FILE: ../../etc/passwd>>>\n```\nx\n```";
    expect(() => parseRepairFiles(escape, new Set(["src/client/apiClient.ts"]))).toThrow(
      /outside the editable set/i,
    );
  });

  it("throws when the model returns no file blocks", () => {
    expect(() => parseRepairFiles("Sure, change line 42.", new Set(["a.ts"]))).toThrow(
      /no <<<FILE/i,
    );
  });

  it("parses multiple file blocks", () => {
    const multi = [
      "<<<FILE: a.ts>>>",
      "```ts",
      "export const a = 1;",
      "```",
      "<<<FILE: b.ts>>>",
      "```ts",
      "export const b = 2;",
      "```",
    ].join("\n");
    const files = parseRepairFiles(multi, new Set(["a.ts", "b.ts"]));
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(files[1]!.content).toContain("export const b = 2;");
  });
});
