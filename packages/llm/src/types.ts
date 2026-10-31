/**
 * The LLM contract (P0-4 / FR-013). Call sites depend on this interface, not on
 * Anthropic's SDK, so tests can drive every LLM stage with a scripted client.
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
  /** Default 0: structural/proposal calls must be deterministic (P0-4). */
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
