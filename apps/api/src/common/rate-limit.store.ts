/**
 * In-memory fixed-window rate-limit counter (P6-5, §24). One process, one map —
 * adequate for the single-instance MVP; swap for a shared store (Redis) when the
 * API is horizontally scaled. Pure and clock-injectable so it is unit-testable.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still permitted in the current window (0 when blocked). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** Seconds until reset, for a `Retry-After` header (>= 1). */
  retryAfterSec: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimitStore {
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  /**
   * Record one hit against `key` and decide if it is allowed. A new window opens
   * on the first hit (or once the previous one expires) and admits up to `limit`
   * requests before blocking until `resetAt`.
   */
  hit(key: string, limit: number, windowMs: number, now: number): RateLimitDecision {
    this.maybeSweep(now);

    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      const resetAt = now + windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: limit - 1, resetAt, retryAfterSec: secsUntil(resetAt, now) };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: existing.resetAt,
        retryAfterSec: secsUntil(existing.resetAt, now),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: limit - existing.count,
      resetAt: existing.resetAt,
      retryAfterSec: secsUntil(existing.resetAt, now),
    };
  }

  /** Drop expired windows occasionally so the map can't grow unbounded. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < 60_000 && this.windows.size < 10_000) return;
    this.lastSweep = now;
    for (const [key, win] of this.windows) {
      if (now >= win.resetAt) this.windows.delete(key);
    }
  }
}

function secsUntil(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}
