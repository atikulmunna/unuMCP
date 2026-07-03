import type { FetchLike, LlmClient, LlmCompletion, LlmRequest } from "./types";

export interface OpenAiCompatibleOptions {
  apiKey: string;
  /** Model id in the provider's catalog. */
  model: string;
  /** API root; `/chat/completions` is appended. */
  baseUrl: string;
  /** Short label used in error messages, e.g. "NIM", "Gemini". */
  provider: string;
  timeoutMs?: number;
  /** Provider-specific fields merged into every request body (e.g. Gemini's
   *  `reasoning_effort`). Kept out of the provider-agnostic `LlmRequest`. */
  extraBody?: Record<string, unknown>;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * A client for any provider that exposes the OpenAI `/chat/completions` API
 * (Bearer auth, `messages`/`response_format`, `choices[].message.content`).
 * NVIDIA NIM and Google Gemini both offer this shape, so a single implementation
 * over native `fetch` (no SDK dependency) serves both — each provider is just a
 * base URL + default model. The `provider` label only flavours error messages.
 */
export class OpenAiCompatibleClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly provider: string;
  private readonly timeoutMs: number;
  private readonly extraBody?: Record<string, unknown>;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAiCompatibleOptions) {
    const provider = options.provider || "LLM";
    if (!options.apiKey) throw new Error(`${provider} client requires an apiKey.`);
    if (!options.model) throw new Error(`${provider} client requires a model id.`);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.provider = provider;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.extraBody = options.extraBody;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.json) body.response_format = { type: "json_object" };
    if (this.extraBody) Object.assign(body, this.extraBody);

    const startedAt = Date.now();
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;

    const raw = await res.text();
    if (!res.ok) {
      // Surface status + a trimmed body; the API filter redacts before the wire.
      throw new Error(`${this.provider} request failed (${res.status}): ${raw.slice(0, 500)}`);
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new Error(`${this.provider} returned non-JSON response: ${raw.slice(0, 200)}`);
    }

    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error(`${this.provider} response had no message content.`);
    }

    return {
      text,
      model: parsed.model ?? this.model,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
      },
      latencyMs,
    };
  }
}
