/**
 * LLM cost estimation (NFR-007b, P6-7). Turns token counts into an estimated
 * USD cost from a per-model price table. Both current providers run on **free
 * tiers** (NVIDIA dev tier, Gemini AI Studio free), so the default cost is 0 —
 * the token counts are the meaningful number today. Add a paid tier's per-1M
 * prices here (or override via env) when one is used, and the metrics pick it up.
 */
export interface TokenPrice {
  /** USD per 1,000,000 input tokens. */
  inputPerM: number;
  /** USD per 1,000,000 output tokens. */
  outputPerM: number;
}

/** Known paid prices, keyed by model id. Free-tier models are simply absent (→ 0). */
const PRICE_TABLE: Record<string, TokenPrice> = {
  // e.g. "gemini-3.5-pro": { inputPerM: 1.25, outputPerM: 5 },  // add when on a paid tier
};

/** Estimated USD for a call, rounded to 6 dp. Unknown/free model → 0 (never NaN). */
export function estimateCostUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  table: Record<string, TokenPrice> = PRICE_TABLE,
): number {
  const price = model ? table[model] : undefined;
  if (!price) return 0;
  const usd = (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
