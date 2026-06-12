import type { FetchLike, LlmClient, LlmCompletion, LlmRequest } from "./types";

/** Default NVIDIA API-catalog endpoint (OpenAI-compatible). */
export const NIM_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export interface NimClientOptions {
  apiKey: string;
  /** Catalog model id, e.g. "meta/llama-3.3-70b-instruct". */
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * NVIDIA NIM client over the OpenAI-compatible `/chat/completions` API. Uses
 * native `fetch` (no SDK dependency) so the package stays dependency-free.
 */
export class NimClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: NimClientOptions) {
    if (!options.apiKey) throw new Error("NimClient requires an apiKey.");
    if (!options.model) throw new Error("NimClient requires a model id.");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? NIM_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
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
      throw new Error(`NIM request failed (${res.status}): ${raw.slice(0, 500)}`);
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new Error(`NIM returned non-JSON response: ${raw.slice(0, 200)}`);
    }

    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("NIM response had no message content.");
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
