/**
 * Provider-agnostic LLM contract (P0-4 / FR-013). The platform's stack was
 * originally locked to Anthropic; this interface decouples the call sites from
 * the provider so NVIDIA NIM (OpenAI-compatible) can be the first implementation
 * and Anthropic (or any other) can be swapped in without touching callers.
 */

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmRequest {
  messages: LlmMessage[];
  /** Default 0 — structural/proposal calls must be deterministic (P0-4). */
  temperature?: number;
  maxTokens?: number;
  /** Hint the provider to emit a single JSON object when supported. */
  json?: boolean;
}

export interface LlmCompletion {
  text: string;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmCompletion>;
}

/** Minimal fetch surface we depend on — injectable so tests need no network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
