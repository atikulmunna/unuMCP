import { describe, expect, it, vi } from "vitest";
import { LlmService, llmConfigFromEnv } from "../src/llm/llm.service";
import type { LlmClient } from "@unumcp/llm";

const facts = [
  { toolName: "create_issue", method: "post", path: "/repos/{owner}/{repo}/issues", mutates: true, riskLevel: "medium" },
];

/** A fake provider answering the batch format with one description for create_issue. */
function batchReply(description: string, model: string): LlmClient {
  return {
    complete: vi.fn(async () => ({
      text: JSON.stringify({ descriptions: [{ name: "create_issue", description }] }),
      model,
      usage: { inputTokens: 100, outputTokens: 12 },
      latencyMs: 3,
    })),
  };
}

describe("LlmService (P2-5)", () => {
  it("is disabled and returns null when no client is configured", async () => {
    const svc = new LlmService({ enabled: false, model: "m" });
    expect(svc.enabled).toBe(false);
    expect((await svc.describeAndRateToolsBatch(facts)).descriptions).toEqual([null]);
  });

  it("returns the LLM description when enabled", async () => {
    const client = batchReply("Creates an issue. Modifies data.", "claude-haiku-4-5");
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client);
    expect(svc.enabled).toBe(true);
    expect((await svc.describeAndRateToolsBatch(facts)).descriptions[0]).toMatch(/creates an issue/i);
  });

  it("falls back to null (never throws) when the provider errors", async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error("Anthropic request failed (529)");
      }),
    };
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client);
    expect((await svc.describeAndRateToolsBatch(facts)).descriptions).toEqual([null]);
  });

  it("is off unless opted in with LLM_PROVIDER=anthropic and a key", () => {
    expect(llmConfigFromEnv({}).enabled).toBe(false);
    // A key alone never starts paid usage (it is often exported globally for other tools).
    expect(llmConfigFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x" }).enabled).toBe(false);
    // Opted in but no key: disabled, deterministic fallback.
    expect(llmConfigFromEnv({ LLM_PROVIDER: "anthropic" }).enabled).toBe(false);
    // Explicit opt-out wins even when configured.
    expect(
      llmConfigFromEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", LLM_DISABLED: "true" }).enabled,
    ).toBe(false);
  });

  it("uses Claude Haiku 4.5 by default, with a model override", () => {
    const cfg = llmConfigFromEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(cfg).toEqual({ enabled: true, apiKey: "sk-ant-x", model: "claude-haiku-4-5" });
    expect(
      llmConfigFromEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-sonnet-5-5" }).model,
    ).toBe("claude-sonnet-5-5");
  });
});
