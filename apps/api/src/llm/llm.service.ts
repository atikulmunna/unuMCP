import { Injectable, Logger } from "@nestjs/common";
import {
  NimClient,
  proposeToolDescription,
  repairCode,
  type LlmClient,
  type RepairInput,
  type RepairResult,
  type ToolProposalInput,
} from "@unumcp/llm";

export interface LlmConfig {
  enabled: boolean;
  model: string;
  apiKey?: string;
}

const DEFAULT_MODEL = "meta/llama-3.3-70b-instruct";

/** Resolve LLM config from env. Disabled when no key is present (or opted out). */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.NVIDIA_API_KEY ?? env.NIM_API_KEY;
  return {
    enabled: Boolean(apiKey) && env.LLM_DISABLED !== "true",
    model: env.NIM_MODEL ?? DEFAULT_MODEL,
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
  ) {
    this.client =
      client ??
      (config.enabled && config.apiKey
        ? new NimClient({ apiKey: config.apiKey, model: config.model })
        : null);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** LLM-authored tool description, or `null` to signal "use the fallback". */
  async describeTool(input: ToolProposalInput): Promise<string | null> {
    if (!this.client) return null;
    try {
      const result = await proposeToolDescription(this.client, input);
      return result.description;
    } catch (err) {
      // Never surface provider detail or block the pipeline; log a safe note.
      this.logger.warn(
        `LLM description failed for "${input.toolName}" (${err instanceof Error ? err.name : "error"}); using deterministic fallback.`,
      );
      return null;
    }
  }

  /**
   * One LLM repair pass over the failing implementation files (P4-5, FR-026).
   * Unlike `describeTool`, this throws on a provider/parse error so the repair
   * orchestrator can record the failed attempt and stop the bounded loop — a
   * silent `null` would be mistaken for "no change needed". Tests stay frozen by
   * construction (the parser rejects any test path).
   */
  async repair(input: RepairInput): Promise<RepairResult> {
    if (!this.client) throw new Error("LLM is disabled; cannot run the repair loop.");
    return repairCode(this.client, input);
  }
}
