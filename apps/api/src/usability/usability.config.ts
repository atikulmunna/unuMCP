import { clampedInt } from "../common/env-int";

/**
 * Limits for one agent usability check. Every check spends LLM calls, so the
 * task count, the calls in flight, and the total calls are all capped.
 */
export interface UsabilityConfig {
  /** Tasks per check (one per tested tool). */
  maxTasks: number;
  /** Agent calls in flight at once; stays well under provider rate limits. */
  concurrency: number;
  /** Hard ceiling on LLM calls per check; the run fails beyond it. */
  maxCalls: number;
}

export function usabilityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UsabilityConfig {
  return {
    maxTasks: clampedInt(env.USABILITY_MAX_TASKS, 40, 2, 100),
    concurrency: clampedInt(env.USABILITY_CONCURRENCY, 2, 1, 8),
    maxCalls: clampedInt(env.USABILITY_MAX_CALLS, 150, 10, 500),
  };
}
