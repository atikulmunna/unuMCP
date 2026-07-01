/**
 * Tuning for the batched tool-description stage (P2-6, NFR-007b). NIM has no
 * prompt caching, so the cost/latency lever for a large spec is fewer, larger
 * LLM calls: describe `batchSize` tools per call, and run up to `concurrency`
 * batches at once. Both are env-overridable and clamped to sane bounds.
 */
export interface ProposalConfig {
  batchSize: number;
  concurrency: number;
}

export function proposalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProposalConfig {
  return {
    batchSize: clampInt(env.PROPOSAL_BATCH_SIZE, 5, 1, 20),
    concurrency: clampInt(env.PROPOSAL_CONCURRENCY, 3, 1, 10),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
