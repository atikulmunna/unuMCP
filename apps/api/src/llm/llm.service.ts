import { Injectable, Logger } from "@nestjs/common";
import {
  AnthropicClient,
  ANTHROPIC_DEFAULT_MODEL,
  proposeToolDescriptions,
  repairCode,
  type LlmClient,
  type RepairInput,
  type ProposedRisk,
  type RepairResult,
  type ToolProposalInput,
} from "@unumcp/llm";
import type { LlmTraceContext, LlmTraceEntry, LlmTraceService } from "./llm-trace.service";

export interface LlmConfig {
  enabled: boolean;
  model: string;
  apiKey?: string;
}

/**
 * Resolve LLM config from env. The LLM is Claude, through Anthropic's API, and
 * it is opt-in: it runs only with `LLM_PROVIDER=anthropic` and an
 * `ANTHROPIC_API_KEY`. Claude bills per token, and `ANTHROPIC_API_KEY` is often
 * exported globally for other tools, so a key alone must never start spending.
 * `LLM_DISABLED=true` turns it off even when configured.
 */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.ANTHROPIC_API_KEY;
  return {
    enabled: env.LLM_PROVIDER === "anthropic" && Boolean(apiKey) && env.LLM_DISABLED !== "true",
    model: env.ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL,
    apiKey,
  };
}

/**
 * Thin LLM seam for the platform (P2-5, FR-013). Wraps the `@unumcp/llm`
 * client so call sites never touch the provider SDK, and **degrades
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
    this.client = client ?? createClient(config);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** The configured model id when enabled (for cost estimation / run metadata). */
  get model(): string | null {
    return this.client ? this.config.model : null;
  }

  /**
   * Describe and rate a batch of tools in one LLM round-trip (P2-6, NFR-007b).
   * Both arrays are aligned to `inputs`. A `null` description means the model
   * gave no usable one, so the caller keeps its deterministic draft; a rating is
   * a second opinion that callers may only use to raise a tool's risk. Never
   * throws: an LLM hiccup must not block tool proposal, so any failure yields
   * all `null`, a safe log line, and, when a project `ctx` is given, an error
   * trace (FR-031).
   */
  async describeAndRateToolsBatch(
    inputs: ToolProposalInput[],
    ctx?: LlmTraceContext,
  ): Promise<{ descriptions: (string | null)[]; risks: (ProposedRisk | null)[] }> {
    const none = () => ({ descriptions: inputs.map(() => null), risks: inputs.map(() => null) });
    if (!this.client || inputs.length === 0) return none();
    const inputSummary = `${inputs.length} tool(s): ${inputs.map((i) => i.toolName).join(", ")}`;
    try {
      const result = await proposeToolDescriptions(this.client, inputs);
      const filled = result.descriptions.filter((d) => d !== null).length;
      const rated = result.risks.filter((r) => r !== null).length;
      await this.recordTrace(ctx, {
        toolName: "propose_tool_descriptions_batch",
        inputSummary,
        outputSummary: `described ${filled}/${inputs.length} tool(s), rated ${rated}`,
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return { descriptions: result.descriptions, risks: result.risks };
    } catch (err) {
      await this.recordTrace(ctx, {
        toolName: "propose_tool_descriptions_batch",
        inputSummary,
        error: errText(err),
      });
      this.logger.warn(
        `LLM batch description failed for ${inputs.length} tool(s) (${err instanceof Error ? err.name : "error"}); using deterministic fallback.`,
      );
      return none();
    }
  }

  /**
   * One LLM repair pass over the failing implementation files (P4-5, FR-026).
   * Unlike describing, this throws on a provider/parse error so the repair
   * orchestrator can record the failed attempt and stop the bounded loop; a
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

/** The configured provider's client, or `null` when the LLM is disabled. */
function createClient(config: LlmConfig): LlmClient | null {
  if (!config.enabled || !config.apiKey) return null;
  return new AnthropicClient({ apiKey: config.apiKey, model: config.model });
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
