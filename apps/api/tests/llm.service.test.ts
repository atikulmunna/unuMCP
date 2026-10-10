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
    const client = batchReply("Creates an issue. Modifies data.", "meta/llama-3.3-70b-instruct");
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client);
    expect(svc.enabled).toBe(true);
    expect((await svc.describeAndRateToolsBatch(facts)).descriptions[0]).toMatch(/creates an issue/i);
  });

  it("falls back to null (never throws) when the provider errors", async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error("NIM request failed (503)");
      }),
    };
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client);
    expect((await svc.describeAndRateToolsBatch(facts)).descriptions).toEqual([null]);
  });

  it("derives enabled/model from env", () => {
    expect(llmConfigFromEnv({}).enabled).toBe(false);
    const cfg = llmConfigFromEnv({ NVIDIA_API_KEY: "nvapi-x" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.provider).toBe("nim");
    expect(cfg.model).toBe("meta/llama-3.3-70b-instruct");
    // Explicit opt-out wins even with a key present.
    expect(llmConfigFromEnv({ NVIDIA_API_KEY: "k", LLM_DISABLED: "true" }).enabled).toBe(false);
  });

  it("auto-selects Gemini when a Gemini key is present", () => {
    const cfg = llmConfigFromEnv({ GEMINI_API_KEY: "AIza-x" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.provider).toBe("gemini");
    expect(cfg.model).toBe("gemini-3.5-flash");
    expect(cfg.apiKey).toBe("AIza-x");
  });

  it("honours an explicit LLM_PROVIDER and model override", () => {
    // Force NIM even though a Gemini key is also present.
    const nim = llmConfigFromEnv({ LLM_PROVIDER: "nim", NVIDIA_API_KEY: "k", GEMINI_API_KEY: "g" });
    expect(nim.provider).toBe("nim");
    expect(nim.apiKey).toBe("k");
    const gem = llmConfigFromEnv({ GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-3.5-pro" });
    expect(gem.model).toBe("gemini-3.5-pro");
  });

  it("selects Anthropic only on an explicit LLM_PROVIDER, defaulting to Claude Haiku 4.5", () => {
    // A key alone never starts paid usage (it's often exported globally for other tools).
    const keyOnly = llmConfigFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(keyOnly.provider).toBe("nim");
    expect(keyOnly.enabled).toBe(false);
    // Nor does it outrank the free Gemini tier.
    expect(llmConfigFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x", GEMINI_API_KEY: "g" }).provider).toBe("gemini");

    const cfg = llmConfigFromEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x", GEMINI_API_KEY: "g" });
    expect(cfg).toMatchObject({ enabled: true, provider: "anthropic", apiKey: "sk-ant-x", model: "claude-haiku-4-5" });
    expect(
      llmConfigFromEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-sonnet-5-5" }).model,
    ).toBe("claude-sonnet-5-5");
    // Opted in but no key: disabled, deterministic fallback.
    expect(llmConfigFromEnv({ LLM_PROVIDER: "anthropic" }).enabled).toBe(false);
  });

  it("builds a working Gemini-backed service from config (no real network)", async () => {
    // Provider selection picks GeminiClient; we still inject a fake client to
    // assert the seam is provider-agnostic end to end.
    const client = batchReply("Fetches a widget.", "gemini-3.5-flash");
    const svc = new LlmService(
      { enabled: true, provider: "gemini", model: "gemini-3.5-flash", apiKey: "AIza" },
      client,
    );
    expect(svc.enabled).toBe(true);
    expect((await svc.describeAndRateToolsBatch(facts)).descriptions[0]).toMatch(/fetches a widget/i);
  });
});
