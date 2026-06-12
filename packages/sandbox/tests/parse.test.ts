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
