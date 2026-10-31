import { clampedInt } from "../common/env-int";

/**
 * Tuning for the batched tool-description stage (P2-6, NFR-007b). For a large
 * spec the cost/latency lever is fewer, larger LLM calls: describe `batchSize`
 * tools per call, and run up to `concurrency` batches at once. Both are
 * env-overridable and clamped to sane bounds.
 */
export interface ProposalConfig {
  batchSize: number;
  concurrency: number;
}

export function proposalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProposalConfig {
  return {
    batchSize: clampedInt(env.PROPOSAL_BATCH_SIZE, 5, 1, 20),
    concurrency: clampedInt(env.PROPOSAL_CONCURRENCY, 3, 1, 10),
  };
}
