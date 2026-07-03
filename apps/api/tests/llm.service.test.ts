import { describe, expect, it, vi } from "vitest";
import { LlmService, llmConfigFromEnv } from "../src/llm/llm.service";
import type { LlmClient } from "@unumcp/llm";

const facts = {
  toolName: "create_issue",
  method: "post",
  path: "/repos/{owner}/{repo}/issues",
  paramNames: ["owner", "repo"],
  mutates: true,
  riskLevel: "medium",
};

describe("LlmService (P2-5)", () => {
  it("is disabled and returns null when no client is configured", async () => {
    const svc = new LlmService({ enabled: false, model: "m" });
    expect(svc.enabled).toBe(false);
    expect(await svc.describeTool(facts)).toBeNull();
  });

  it("returns the LLM description when enabled", async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => ({
        text: '{"description":"Creates an issue. Modifies data."}',
        model: "meta/llama-3.3-70b-instruct",
        usage: { inputTokens: 100, outputTokens: 12 },
        latencyMs: 3,
      })),
    };
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client);
    expect(svc.enabled).toBe(true);
    expect(await svc.describeTool(facts)).toMatch(/creates an issue/i);
  });

  it("falls back to null (never throws) when the provider errors", async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error("NIM request failed (503)");
      }),
    };
    const svc = new LlmService({ enabled: true, model: "m", apiKey: "k" }, client);
    expect(await svc.describeTool(facts)).toBeNull();
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

  it("builds a working Gemini-backed service from config (no real network)", async () => {
    // Provider selection picks GeminiClient; we still inject a fake client to
    // assert the seam is provider-agnostic end to end.
    const client: LlmClient = {
      complete: vi.fn(async () => ({
        text: '{"description":"Fetches a widget."}',
        model: "gemini-3.5-flash",
        usage: { inputTokens: 40, outputTokens: 6 },
        latencyMs: 2,
      })),
    };
    const svc = new LlmService(
      { enabled: true, provider: "gemini", model: "gemini-3.5-flash", apiKey: "AIza" },
      client,
    );
    expect(svc.enabled).toBe(true);
    expect(await svc.describeTool(facts)).toMatch(/fetches a widget/i);
  });
});
