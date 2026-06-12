import { describe, expect, it } from "vitest";
import { computeWarnings, renderWarningsMarkdown } from "../src/completion/warnings";

describe("computeWarnings", () => {
  it("is clean when auth is detected and tests ran", () => {
    expect(
      computeWarnings({ authNeedsUserConfig: false, totalTestCount: 4, failingTestCount: 0 }),
    ).toEqual([]);
  });

  it("warns when auth could not be auto-detected (F-1)", () => {
    const w = computeWarnings({ authNeedsUserConfig: true, totalTestCount: 4, failingTestCount: 0 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/auto-detected/i);
  });

  it("warns when no tests were generated", () => {
    const w = computeWarnings({ authNeedsUserConfig: false, totalTestCount: 0, failingTestCount: 0 });
    expect(w[0]).toMatch(/no tests/i);
  });

  it("accumulates multiple warnings", () => {
    expect(
      computeWarnings({ authNeedsUserConfig: true, totalTestCount: 0, failingTestCount: 0 }),
    ).toHaveLength(2);
  });
});

describe("renderWarningsMarkdown", () => {
  it("renders each warning as a bullet under a heading", () => {
    const md = renderWarningsMarkdown(["one", "two"]);
    expect(md).toContain("# Build Warnings");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });
});
