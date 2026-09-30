/**
 * Map over `items` running at most `limit` calls of `fn` at once, preserving
 * input order in the results. Used to keep LLM fan-out polite without pulling in
 * a dependency — now driving concurrent description *batches* (P2-6).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface Limiter {
  /** True when a new `acquire` would have to wait. */
  readonly saturated: boolean;
  /**
   * Wait for a slot (FIFO) and resolve to its release function, or to `null`
   * if `signal` aborts while still waiting (the slot is then never taken).
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | null>;
}

/** A counting semaphore: at most `limit` concurrent holders, the rest queue in order. */
export function createLimiter(limit: number): Limiter {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: Array<() => void> = [];

  const releaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next(); // hand the slot straight to the next waiter
      else active--;
    };
  };

  return {
    get saturated() {
      return active >= max;
    },
    acquire(signal) {
      if (signal?.aborted) return Promise.resolve(null);
      if (active < max) {
        active++;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve) => {
        const grant = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(releaser());
        };
        const onAbort = () => {
          const i = waiting.indexOf(grant);
          if (i >= 0) waiting.splice(i, 1);
          resolve(null);
        };
        waiting.push(grant);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

/** Split `items` into contiguous groups of at most `size`, preserving order (P2-6). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return items.length === 0 ? [] : [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
