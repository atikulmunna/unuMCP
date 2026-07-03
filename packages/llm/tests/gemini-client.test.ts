import { describe, expect, it, vi } from "vitest";
import { GeminiClient } from "../src/gemini-client";
import type { FetchLike } from "../src/types";

function okResponse(payload: unknown): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

const sampleResponse = {
  model: "gemini-3.5-flash",
  choices: [{ message: { content: '{"description":"Creates an issue."}' } }],
  usage: { prompt_tokens: 90, completion_tokens: 12 },
};

describe("GeminiClient", () => {
  it("posts to Gemini's OpenAI-compatible endpoint with a Bearer key", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => okResponse(sampleResponse));
    const client = new GeminiClient({ apiKey: "AIza-test", model: "gemini-3.5-flash", fetchImpl });

    const result = await client.complete({
      messages: [{ role: "user", content: "hi" }],
      json: true,
    });

    expect(result.text).toBe('{"description":"Creates an issue."}');
    expect(result.model).toBe("gemini-3.5-flash");
    expect(result.usage).toEqual({ inputTokens: 90, outputTokens: 12 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(init.headers.authorization).toBe("Bearer AIza-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gemini-3.5-flash");
    expect(body.temperature).toBe(0); // deterministic by default
    expect(body.response_format).toEqual({ type: "json_object" });
    // Thinking disabled — Flash "thinking" spends output tokens and truncates our JSON.
    expect(body.reasoning_effort).toBe("none");
  });

  it("throws a clear, provider-labelled error on a non-2xx response", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("quota exceeded") });
    const client = new GeminiClient({ apiKey: "k", model: "m", fetchImpl });
    await expect(client.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      /Gemini request failed \(429\)/,
    );
  });

  it("requires apiKey and model", () => {
    expect(() => new GeminiClient({ apiKey: "", model: "m" })).toThrow(/apiKey/);
    expect(() => new GeminiClient({ apiKey: "k", model: "" })).toThrow(/model/);
  });
});
