import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_KEY = "rateLimit";

export interface RateLimitOptions {
  /** Max requests allowed per IP within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Tighten the rate limit on a specific handler (P6-5). Sensitive/expensive
 * routes (auth, generation, spec upload) opt into stricter buckets than the
 * global default. Without this decorator a handler uses the global default.
 */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
