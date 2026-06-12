export interface RepairConfig {
  /** Maximum repair passes before giving up (bounded, NFR-006/§11.4). */
  maxAttempts: number;
  /** Token ceiling per repair pass (full corrected files are emitted). */
  maxTokens: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Repair-loop config from env. The attempt count is deliberately small (default
 * 2): each pass runs the LLM (~40s) plus a full sandbox rerun, so the loop must
 * stay tightly bounded to keep total latency and cost in check.
 */
export function repairConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RepairConfig {
  return {
    maxAttempts: intFromEnv(env.MAX_REPAIR_ATTEMPTS, 2),
    maxTokens: intFromEnv(env.REPAIR_MAX_TOKENS, 4096),
  };
}
