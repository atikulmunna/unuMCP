/**
 * LLM cost estimation (NFR-007b, P6-7). Turns token counts into an estimated
 * USD cost from a per-model price table. Gemini (AI Studio) and NVIDIA NIM run
 * on **free tiers**, so they are absent and cost 0; Anthropic is billed per
 * token, so its models are priced here and the metrics show real spend.
 */
export interface TokenPrice {
  /** USD per 1,000,000 input tokens. */
  inputPerM: number;
  /** USD per 1,000,000 output tokens. */
  outputPerM: number;
}

/** Known paid prices, keyed by model id. Free-tier models are simply absent (→ 0). */
const PRICE_TABLE: Record<string, TokenPrice> = {
  // Anthropic list prices. Claude's output tokens include any thinking tokens.
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5 },
  "claude-sonnet-5-5": { inputPerM: 2, outputPerM: 10 },
  "claude-opus-5-5": { inputPerM: 4, outputPerM: 20 },
};

/**
 * Price for a model id. Providers may report a dated snapshot of an alias
 * (the API answers `claude-haiku-4-5` requests as `claude-haiku-4-5-20251001`),
 * which prices as the alias.
 */
function priceFor(model: string, table: Record<string, TokenPrice>): TokenPrice | undefined {
  if (table[model]) return table[model];
  const snapshot = model.match(/^(.+)-\d{8}$/);
  return snapshot ? table[snapshot[1]!] : undefined;
}

/** Estimated USD for a call, rounded to 6 dp. Unknown/free model → 0 (never NaN). */
export function estimateCostUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  table: Record<string, TokenPrice> = PRICE_TABLE,
): number {
  const price = model ? priceFor(model, table) : undefined;
  if (!price) return 0;
  const usd = (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
