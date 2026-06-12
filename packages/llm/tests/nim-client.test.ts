import { describe, expect, it, vi } from "vitest";
import { NimClient } from "../src/nim-client";
import type { FetchLike } from "../src/types";

function okResponse(payload: unknown): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

const sampleResponse = {
  model: "meta/llama-3.3-70b-instruct",
  choices: [{ message: { content: '{"description":"Creates an issue."}' } }],
  usage: { prompt_tokens: 123, completion_tokens: 17 },
};

describe("NimClient", () => {
  it("posts an OpenAI-shaped request and parses content + usage", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => okResponse(sampleResponse));
    const client = new NimClient({
      apiKey: "nvapi-test",
      model: "meta/llama-3.3-70b-instruct",
      fetchImpl,
    });

    const result = await client.complete({
      messages: [{ role: "user", content: "hi" }],
      json: true,
    });

    expect(result.text).toBe('{"description":"Creates an issue."}');
    expect(result.model).toBe("meta/llama-3.3-70b-instruct");
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 17 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer nvapi-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("meta/llama-3.3-70b-instruct");
    expect(body.temperature).toBe(0); // deterministic by default
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("throws a clear error on a non-2xx response", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("rate limited") });
    const client = new NimClient({ apiKey: "k", model: "m", fetchImpl });
    await expect(client.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      /NIM request failed \(429\)/,
    );
  });

  it("throws when the response carries no message content", async () => {
    const fetchImpl: FetchLike = () => okResponse({ model: "m", choices: [], usage: {} });
    const client = new NimClient({ apiKey: "k", model: "m", fetchImpl });
    await expect(client.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      /no message content/i,
    );
  });

  it("requires apiKey and model", () => {
    expect(() => new NimClient({ apiKey: "", model: "m" })).toThrow(/apiKey/);
    expect(() => new NimClient({ apiKey: "k", model: "" })).toThrow(/model/);
  });
});
