import { describe, expect, it } from "vitest";
import { createLimiter, mapWithConcurrency } from "../src/common/concurrency";

describe("createLimiter", () => {
  it("admits up to the limit, then queues in FIFO order", async () => {
    const limiter = createLimiter(1);
    const first = await limiter.acquire();
    expect(limiter.saturated).toBe(true);

    const order: string[] = [];
    const second = limiter.acquire().then((release) => (order.push("second"), release));
    const third = limiter.acquire().then((release) => (order.push("third"), release));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]); // both still waiting

    first!();
    (await second)!();
    (await third)!();
    expect(order).toEqual(["second", "third"]);
    expect(limiter.saturated).toBe(false);
  });

  it("drops a waiter whose signal aborts, without consuming a slot", async () => {
    const limiter = createLimiter(1);
    const held = await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);

    controller.abort();
    expect(await waiting).toBeNull();

    held!();
    expect(limiter.saturated).toBe(false);
    // A second release of the same slot is a no-op.
    held!();
    const again = await limiter.acquire();
    expect(limiter.saturated).toBe(true);
    again!();
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order in the results", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 5, async (x) => x)).toEqual([]);
  });
});
