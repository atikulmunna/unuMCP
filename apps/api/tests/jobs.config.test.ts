import { describe, expect, it } from "vitest";
import { jobsConfigFromEnv } from "../src/jobs/jobs.config";

describe("jobsConfigFromEnv (P6-6)", () => {
  it("runs inline when no REDIS_URL is set", () => {
    const cfg = jobsConfigFromEnv({});
    expect(cfg.inline).toBe(true);
    expect(cfg.redisUrl).toBeUndefined();
  });

  it("uses the queue when REDIS_URL is present", () => {
    const cfg = jobsConfigFromEnv({ REDIS_URL: "redis://localhost:6379" });
    expect(cfg.inline).toBe(false);
    expect(cfg.redisUrl).toBe("redis://localhost:6379");
  });

  it("JOBS_INLINE=true forces inline even with Redis configured", () => {
    const cfg = jobsConfigFromEnv({ REDIS_URL: "redis://x", JOBS_INLINE: "true" });
    expect(cfg.inline).toBe(true);
  });

  it("reads attempts and concurrency with sane defaults", () => {
    expect(jobsConfigFromEnv({}).attempts).toBe(3);
    expect(jobsConfigFromEnv({}).concurrency).toBe(2);
    expect(jobsConfigFromEnv({ JOB_ATTEMPTS: "5", JOB_CONCURRENCY: "4" })).toMatchObject({
      attempts: 5,
      concurrency: 4,
    });
  });
});
