import { Injectable, Logger } from "@nestjs/common";
import {
  GeminiClient,
  NimClient,
  proposeToolDescription,
  proposeToolDescriptions,
  repairCode,
  type LlmClient,
  type RepairInput,
  type RepairResult,
  type ToolProposalInput,
} from "@unumcp/llm";
import type { LlmTraceContext, LlmTraceEntry, LlmTraceService } from "./llm-trace.service";

export type LlmProvider = "nim" | "gemini";

export interface LlmConfig {
  enabled: boolean;
  /** Which OpenAI-compatible backend to talk to. Defaults to "nim". */
  provider?: LlmProvider;
  model: string;
  apiKey?: string;
}

const NIM_DEFAULT_MODEL = "meta/llama-3.3-70b-instruct";
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";

/**
 * Resolve LLM config from env. The provider is chosen by `LLM_PROVIDER` when set,
 * otherwise auto-detected from whichever key is present (Gemini preferred, since
 * its free tier is the common case). Disabled when no key is present or opted out.
 */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const geminiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  const nimKey = env.NVIDIA_API_KEY ?? env.NIM_API_KEY;
  const provider: LlmProvider =
    env.LLM_PROVIDER === "nim" || env.LLM_PROVIDER === "gemini"
      ? env.LLM_PROVIDER
      : geminiKey
        ? "gemini"
        : "nim";
  const apiKey = provider === "gemini" ? geminiKey : nimKey;
  const model =
    provider === "gemini"
      ? (env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL)
      : (env.NIM_MODEL ?? NIM_DEFAULT_MODEL);
  return {
    enabled: Boolean(apiKey) && env.LLM_DISABLED !== "true",
    provider,
    model,
    apiKey,
  };
}

/**
 * Thin LLM seam for the platform (P2-5, FR-013). Wraps the provider-agnostic
 * `@unumcp/llm` client so call sites never touch the provider, and **degrades
 * gracefully**: when the LLM is disabled (no key) or a call fails, it returns
 * `null` so the caller keeps its deterministic fallback. An LLM hiccup must
 * never block tool proposal.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger("LlmService");
  private readonly client: LlmClient | null;

  constructor(
    private readonly config: LlmConfig,
    client?: LlmClient,
    private readonly trace?: LlmTraceService,
  ) {
    this.client =
      client ??
      (config.enabled && config.apiKey
        ? config.provider === "gemini"
          ? new GeminiClient({ apiKey: config.apiKey, model: config.model })
          : new NimClient({ apiKey: config.apiKey, model: config.model })
        : null);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * LLM-authored tool description, or `null` to signal "use the fallback".
   * When a project `ctx` is given, the call is traced (FR-031) — success or error.
   */
  async describeTool(input: ToolProposalInput, ctx?: LlmTraceContext): Promise<string | null> {
    if (!this.client) return null;
    const inputSummary = `${input.method.toUpperCase()} ${input.path} → ${input.toolName}`;
    try {
      const result = await proposeToolDescription(this.client, input);
      await this.recordTrace(ctx, {
        toolName: "propose_tool_description",
        inputSummary,
        outputSummary: result.description,
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return result.description;
    } catch (err) {
      await this.recordTrace(ctx, {
        toolName: "propose_tool_description",
        inputSummary,
        error: errText(err),
      });
      // Never surface provider detail or block the pipeline; log a safe note.
      this.logger.warn(
        `LLM description failed for "${input.toolName}" (${err instanceof Error ? err.name : "error"}); using deterministic fallback.`,
      );
      return null;
    }
  }

  /**
   * Describe a batch of tools in one LLM round-trip (P2-6, NFR-007b). Returns a
   * `(string | null)[]` aligned to `inputs`, with `null` where the model omitted
   * a usable description so the caller keeps its deterministic draft. Like
   * `describeTool` it **never throws** — a provider/parse error yields all-`null`
   * (full fallback) and, when a project `ctx` is given, an error trace (FR-031).
   */
  async describeToolsBatch(
    inputs: ToolProposalInput[],
    ctx?: LlmTraceContext,
  ): Promise<(string | null)[]> {
    if (!this.client) return inputs.map(() => null);
    if (inputs.length === 0) return [];
    const inputSummary = `${inputs.length} tool(s): ${inputs.map((i) => i.toolName).join(", ")}`;
    try {
      const result = await proposeToolDescriptions(this.client, inputs);
      const filled = result.descriptions.filter((d) => d !== null).length;
      await this.recordTrace(ctx, {
        toolName: "propose_tool_descriptions_batch",
        inputSummary,
        outputSummary: `described ${filled}/${inputs.length} tool(s)`,
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return result.descriptions;
    } catch (err) {
      await this.recordTrace(ctx, {
        toolName: "propose_tool_descriptions_batch",
        inputSummary,
        error: errText(err),
      });
      this.logger.warn(
        `LLM batch description failed for ${inputs.length} tool(s) (${err instanceof Error ? err.name : "error"}); using deterministic fallback.`,
      );
      return inputs.map(() => null);
    }
  }

  /**
   * One LLM repair pass over the failing implementation files (P4-5, FR-026).
   * Unlike `describeTool`, this throws on a provider/parse error so the repair
   * orchestrator can record the failed attempt and stop the bounded loop — a
   * silent `null` would be mistaken for "no change needed". Tests stay frozen by
   * construction (the parser rejects any test path).
   */
  async repair(input: RepairInput, ctx?: LlmTraceContext): Promise<RepairResult> {
    if (!this.client) throw new Error("LLM is disabled; cannot run the repair loop.");
    const inputSummary = `${input.files.length} file(s): ${input.files.map((f) => f.path).join(", ")}`;
    try {
      const result = await repairCode(this.client, input);
      await this.recordTrace(ctx, {
        toolName: "repair_code",
        inputSummary,
        outputSummary: `changed ${result.files.length} file(s): ${result.files.map((f) => f.path).join(", ") || "none"}`,
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (err) {
      await this.recordTrace(ctx, { toolName: "repair_code", inputSummary, error: errText(err) });
      throw err;
    }
  }

  /** Record an internal agent tool-call trace when a project context is present. */
  private async recordTrace(
    ctx: LlmTraceContext | undefined,
    entry: Omit<LlmTraceEntry, "projectId">,
  ): Promise<void> {
    if (!ctx || !this.trace) return;
    await this.trace.record({ projectId: ctx.projectId, ...entry });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
