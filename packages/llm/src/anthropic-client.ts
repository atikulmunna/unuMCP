import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type { LlmClient, LlmCompletion, LlmRequest } from "./types";

/**
 * Cheapest current Claude model ($1 / $5 per 1M tokens): plenty for 1 to 3
 * sentence tool descriptions and small implementation repairs.
 */
export const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";

/** Anthropic requires `max_tokens`; every platform call sets its own, this is the backstop. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Models that still accept sampling parameters. Newer Claude models (Opus 4.7+,
 * Sonnet 5+, Fable, Mythos) reject `temperature` with a 400 and think by
 * default, so for them the client omits it and asks for low effort instead:
 * platform calls are short extraction-style tasks, and thinking tokens count
 * against `max_tokens`, where too many would truncate the JSON / file blocks the
 * callers parse.
 */
const SAMPLING_MODELS = /^claude-(haiku-4-5|sonnet-4-[56]|opus-4-[156])/;

export interface AnthropicClientOptions {
  apiKey: string;
  /** Claude model id; defaults to {@link ANTHROPIC_DEFAULT_MODEL}. */
  model?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetch?: ClientOptions["fetch"];
}

/**
 * Claude via the official Anthropic SDK (Messages API). Maps the platform's
 * provider-agnostic request onto it: system messages become the top-level
 * `system` prompt, and the `json` hint is ignored because the Messages API has
 * no JSON mode; the proposal/repair prompts already demand bare output and their
 * parsers strip stray fences. The SDK retries 429/5xx itself (2 retries).
 */
export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicClientOptions) {
    if (!options.apiKey) throw new Error("Anthropic client requires an apiKey.");
    this.model = options.model || ANTHROPIC_DEFAULT_MODEL;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      timeout: options.timeoutMs ?? 60_000,
      fetch: options.fetch,
    });
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages: Anthropic.MessageParam[] = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const startedAt = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      messages,
      ...(SAMPLING_MODELS.test(this.model)
        ? { temperature: request.temperature ?? 0 }
        : { output_config: { effort: "low" as const } }),
    });
    const latencyMs = Date.now() - startedAt;

    if (response.stop_reason === "refusal") {
      // Callers treat a throw as "no usable output" and fall back safely.
      throw new Error(
        `Anthropic declined the request (${response.stop_details?.category ?? "unspecified category"}).`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      latencyMs,
    };
  }
}
