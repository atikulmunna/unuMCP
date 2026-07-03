import { OpenAiCompatibleClient } from "./openai-compatible";
import type { FetchLike } from "./types";

/**
 * Google Gemini's OpenAI-compatibility endpoint. Gemini speaks the same
 * `/chat/completions` shape with `Authorization: Bearer <GEMINI_API_KEY>`, so it
 * reuses {@link OpenAiCompatibleClient} unchanged — only the base URL and model
 * differ. See ai.google.dev "OpenAI compatibility".
 */
export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export interface GeminiClientOptions {
  apiKey: string;
  /** e.g. "gemini-3.5-flash". */
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export class GeminiClient extends OpenAiCompatibleClient {
  constructor(options: GeminiClientOptions) {
    super({
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl ?? GEMINI_DEFAULT_BASE_URL,
      provider: "Gemini",
      timeoutMs: options.timeoutMs,
      // Gemini 2.5/3.x Flash "thinks" by default, spending output tokens on
      // hidden reasoning before it emits — which truncates our JSON mid-object.
      // Every platform call is deterministic extraction (temp 0), so disable
      // thinking: faster, cheaper, and the response is the answer, not a preamble.
      extraBody: { reasoning_effort: "none" },
      fetchImpl: options.fetchImpl,
    });
  }
}
