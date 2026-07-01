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

/** Split `items` into contiguous groups of at most `size`, preserving order (P2-6). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return items.length === 0 ? [] : [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
