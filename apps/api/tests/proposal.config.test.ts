import { describe, expect, it } from "vitest";
import { proposalConfigFromEnv } from "../src/tools/proposal.config";
import { chunk } from "../src/common/concurrency";

describe("proposalConfigFromEnv (P2-6)", () => {
  it("defaults to a sensible batch size and concurrency", () => {
    expect(proposalConfigFromEnv({})).toEqual({ batchSize: 5, concurrency: 3 });
  });

  it("reads and clamps overrides from env", () => {
    expect(proposalConfigFromEnv({ PROPOSAL_BATCH_SIZE: "10", PROPOSAL_CONCURRENCY: "4" })).toEqual({
      batchSize: 10,
      concurrency: 4,
    });
    // Out-of-range values clamp to bounds; garbage falls back to the default.
    expect(proposalConfigFromEnv({ PROPOSAL_BATCH_SIZE: "999" }).batchSize).toBe(20);
    expect(proposalConfigFromEnv({ PROPOSAL_BATCH_SIZE: "0" }).batchSize).toBe(1);
    expect(proposalConfigFromEnv({ PROPOSAL_CONCURRENCY: "nope" }).concurrency).toBe(3);
  });
});

describe("chunk (P2-6)", () => {
  it("splits into contiguous, order-preserving groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("handles empty input and a single full group", () => {
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });
});
