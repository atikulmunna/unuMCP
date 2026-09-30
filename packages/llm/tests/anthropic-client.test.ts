import { describe, expect, it, vi } from "vitest";
import { AnthropicClient, ANTHROPIC_DEFAULT_MODEL } from "../src/anthropic-client";

function messageResponse(overrides: Record<string, unknown> = {}): Response {
  const payload = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: '{"description":"Creates an issue."}' }],
    stop_reason: "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: { input_tokens: 90, output_tokens: 12 },
    ...overrides,
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fake fetch that records every request and replies with `reply()`. */
function fakeFetch(reply: () => Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply());
}

const request = {
  messages: [
    { role: "system" as const, content: "You write tool descriptions." },
    { role: "user" as const, content: "Endpoint facts: ..." },
  ],
  maxTokens: 300,
  json: true,
};

function sentBody(fetch: ReturnType<typeof fakeFetch>) {
  const init = fetch.mock.calls[0]![1]!;
  return JSON.parse(String(init.body));
}

describe("AnthropicClient", () => {
  it("defaults to Claude Haiku 4.5 and maps the request onto the Messages API", async () => {
    const fetch = fakeFetch(() => messageResponse());
    const client = new AnthropicClient({ apiKey: "sk-ant-test", fetch });

    const result = await client.complete(request);

    expect(result.text).toBe('{"description":"Creates an issue."}');
    // The dated snapshot the API reports is kept for run metadata / pricing.
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.usage).toEqual({ inputTokens: 90, outputTokens: 12 });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/messages$/);
    expect(new Headers(init!.headers).get("x-api-key")).toBe("sk-ant-test");
    const body = sentBody(fetch);
    expect(body.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(body.max_tokens).toBe(300);
    // System messages move to the top-level prompt; only user/assistant stay in messages.
    expect(body.system).toBe("You write tool descriptions.");
    expect(body.messages).toEqual([{ role: "user", content: "Endpoint facts: ..." }]);
    // Haiku 4.5 accepts sampling, so the deterministic temperature is sent...
    expect(body.temperature).toBe(0);
    // ...and neither JSON mode nor effort (which Haiku 4.5 rejects).
    expect(body.output_config).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it("omits temperature and asks for low effort on current-generation models", async () => {
    const fetch = fakeFetch(() => messageResponse({ model: "claude-sonnet-5-5" }));
    const client = new AnthropicClient({ apiKey: "k", model: "claude-sonnet-5-5", fetch });

    await client.complete(request);

    const body = sentBody(fetch);
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("joins only the text blocks of the reply", async () => {
    const fetch = fakeFetch(() =>
      messageResponse({
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "part one, " },
          { type: "text", text: "part two" },
        ],
      }),
    );
    const client = new AnthropicClient({ apiKey: "k", fetch });
    expect((await client.complete(request)).text).toBe("part one, part two");
  });

  it("throws on a refusal so callers fall back instead of parsing an empty reply", async () => {
    const fetch = fakeFetch(() =>
      messageResponse({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
      }),
    );
    const client = new AnthropicClient({ apiKey: "k", fetch });
    await expect(client.complete(request)).rejects.toThrow(/declined the request \(cyber\)/);
  });

  it("surfaces API errors (e.g. an exhausted credit balance) as a rejection", async () => {
    const fetch = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "Your credit balance is too low." },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new AnthropicClient({ apiKey: "k", fetch });
    await expect(client.complete(request)).rejects.toThrow(/credit balance is too low/);
    expect(fetch).toHaveBeenCalledTimes(1); // a 400 is not retried
  });

  it("requires an apiKey", () => {
    expect(() => new AnthropicClient({ apiKey: "" })).toThrow(/apiKey/);
  });
});
