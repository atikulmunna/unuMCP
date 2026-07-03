import { OpenAiCompatibleClient } from "./openai-compatible";
import type { FetchLike } from "./types";

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

/**
 * NVIDIA NIM client over the OpenAI-compatible `/chat/completions` API. A thin
 * preset over {@link OpenAiCompatibleClient} (native `fetch`, no SDK dependency).
 */
export class NimClient extends OpenAiCompatibleClient {
  constructor(options: NimClientOptions) {
    super({
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl ?? NIM_DEFAULT_BASE_URL,
      provider: "NIM",
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }
}
