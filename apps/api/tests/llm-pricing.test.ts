import { describe, expect, it } from "vitest";
import { estimateCostUsd, type TokenPrice } from "../src/llm/llm-pricing";

describe("estimateCostUsd (P6-7, NFR-007b)", () => {
  it("returns 0 for free-tier / unknown / null models (never NaN)", () => {
    expect(estimateCostUsd("gemini-3.5-flash", 1000, 500)).toBe(0);
    expect(estimateCostUsd("meta/llama-3.3-70b-instruct", 9999, 9999)).toBe(0);
    expect(estimateCostUsd(null, 1000, 500)).toBe(0);
    expect(estimateCostUsd(undefined, 1000, 500)).toBe(0);
  });

  it("computes cost per 1M tokens when the model is priced", () => {
    const table: Record<string, TokenPrice> = { "paid-model": { inputPerM: 1, outputPerM: 3 } };
    // 1M input × $1/M + 1M output × $3/M = $4
    expect(estimateCostUsd("paid-model", 1_000_000, 1_000_000, table)).toBe(4);
    // Fractional usage rounds to 6 dp.
    expect(estimateCostUsd("paid-model", 500_000, 0, table)).toBe(0.5);
    // A model not in the table is still free.
    expect(estimateCostUsd("other", 1_000_000, 1_000_000, table)).toBe(0);
  });
});
