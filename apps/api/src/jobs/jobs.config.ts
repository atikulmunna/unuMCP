export interface JobsConfig {
  /** When true, jobs run synchronously in-process (no Redis). */
  inline: boolean;
  redisUrl?: string;
  /** Retry attempts for a failed job (transient errors). */
  attempts: number;
  /** Worker concurrency. */
  concurrency: number;
}

/**
 * Resolve job config from env (P6-6). The queue is opt-in: with **no
 * `REDIS_URL`** the platform runs jobs **inline** so dev/test/CI need no Redis;
 * setting `REDIS_URL` switches to the durable BullMQ queue. `JOBS_INLINE=true`
 * forces inline even when Redis is configured (used by the test suite).
 */
export function jobsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  const redisUrl = env.REDIS_URL;
  return {
    redisUrl,
    inline: env.JOBS_INLINE === "true" || !redisUrl,
    attempts: Number(env.JOB_ATTEMPTS ?? 3),
    concurrency: Number(env.JOB_CONCURRENCY ?? 2),
  };
}
