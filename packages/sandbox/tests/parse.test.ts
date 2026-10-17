import { describe, expect, it } from "vitest";
import { parseTestSummary, truncateLog } from "../src/parse";

// Real Vitest summary blocks (the formats this project's own runs produce).
const passing = `
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  12:18:10
   Duration  2.64s
`;

const failing = `
 Test Files  1 failed (2)
      Tests  1 failed | 8 passed (9)
   Start at  12:23:49
`;

const withSkips = `      Tests  10 passed | 2 skipped (12)\n`;

describe("parseTestSummary", () => {
  it("parses an all-passing run", () => {
    expect(parseTestSummary(passing)).toEqual({ passed: 4, failed: 0, skipped: 0, total: 4 });
  });

  it("parses a run with failures (and ignores the Test Files line)", () => {
    expect(parseTestSummary(failing)).toEqual({ passed: 8, failed: 1, skipped: 0, total: 9 });
  });

  it("parses skipped counts", () => {
    expect(parseTestSummary(withSkips)).toEqual({ passed: 10, failed: 0, skipped: 2, total: 12 });
  });

  it("reads a coloured summary the same as a plain one", () => {
    // Vitest 5's summary line as it appears when colour is on.
    const coloured =
      "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m6 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m" +
      "\u001b[1m\u001b[32m19 passed\u001b[39m\u001b[22m\u001b[90m (25)\u001b[39m\n";
    expect(parseTestSummary(coloured)).toEqual({ passed: 19, failed: 6, skipped: 0, total: 25 });
  });

  it("returns zeros when no summary is present", () => {
    expect(parseTestSummary("npm ERR! something exploded")).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    });
  });
});

describe("truncateLog", () => {
  it("leaves short logs unchanged", () => {
    expect(truncateLog("short", 100)).toBe("short");
  });

  it("keeps the tail and marks truncation when over the cap", () => {
    const log = "A".repeat(50) + "TAIL";
    const out = truncateLog(log, 10);
    expect(out.startsWith("…[truncated]")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(Buffer.byteLength(out.replace("…[truncated]\n", ""))).toBe(10);
  });
});
