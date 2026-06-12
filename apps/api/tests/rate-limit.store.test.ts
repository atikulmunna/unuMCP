import { describe, expect, it } from "vitest";
import { RateLimitStore } from "../src/common/rate-limit.store";

describe("RateLimitStore (P6-5)", () => {
  it("admits up to the limit, then blocks within the window", () => {
    const store = new RateLimitStore();
    const t0 = 1_000_000;

    const first = store.hit("k", 3, 10_000, t0);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    expect(store.hit("k", 3, 10_000, t0 + 1).allowed).toBe(true);
    expect(store.hit("k", 3, 10_000, t0 + 2).remaining).toBe(0);

    const blocked = store.hit("k", 3, 10_000, t0 + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("opens a fresh window once the previous one expires", () => {
    const store = new RateLimitStore();
    const t0 = 1_000_000;
    store.hit("k", 1, 10_000, t0);
    expect(store.hit("k", 1, 10_000, t0 + 5_000).allowed).toBe(false);

    // After resetAt (t0 + windowMs) the counter restarts.
    const renewed = store.hit("k", 1, 10_000, t0 + 10_000);
    expect(renewed.allowed).toBe(true);
    expect(renewed.remaining).toBe(0);
  });

  it("keeps separate keys independent", () => {
    const store = new RateLimitStore();
    const t0 = 1_000_000;
    store.hit("a", 1, 10_000, t0);
    // Different key (different IP/endpoint) is unaffected by a's exhaustion.
    expect(store.hit("b", 1, 10_000, t0).allowed).toBe(true);
    expect(store.hit("a", 1, 10_000, t0).allowed).toBe(false);
  });

  it("reports retryAfterSec rounded up to whole seconds", () => {
    const store = new RateLimitStore();
    const t0 = 0;
    store.hit("k", 1, 2_500, t0);
    const blocked = store.hit("k", 1, 2_500, t0 + 100); // ~2.4s remain
    expect(blocked.retryAfterSec).toBe(3);
  });
});
