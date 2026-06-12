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
    expect(cfg.model).toBe("meta/llama-3.3-70b-instruct");
    // Explicit opt-out wins even with a key present.
    expect(llmConfigFromEnv({ NVIDIA_API_KEY: "k", LLM_DISABLED: "true" }).enabled).toBe(false);
  });
});
