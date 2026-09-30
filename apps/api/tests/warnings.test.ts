import { describe, expect, it } from "vitest";
import {
  computeWarnings,
  renderWarningsMarkdown,
  testOutcomeOf,
  type WarningFacts,
} from "../src/completion/warnings";

const clean: WarningFacts = {
  authNeedsUserConfig: false,
  testOutcome: "passed",
  totalTestCount: 4,
  failingTestCount: 0,
};

describe("computeWarnings", () => {
  it("is clean when auth is detected and the tests passed", () => {
    expect(computeWarnings(clean)).toEqual([]);
  });

  it("warns when auth could not be auto-detected (F-1)", () => {
    const w = computeWarnings({ ...clean, authNeedsUserConfig: true });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/auto-detected/i);
  });

  it("warns when no tests were generated", () => {
    const w = computeWarnings({ ...clean, totalTestCount: 0 });
    expect(w[0]).toMatch(/no tests/i);
  });

  it("says how many tests failed when the shipped code failed its tests", () => {
    const w = computeWarnings({ ...clean, testOutcome: "failed", totalTestCount: 8, failingTestCount: 3 });
    expect(w).toEqual([expect.stringMatching(/3 of 8 failed/)]);
  });

  it("calls the build untested when the sandbox errored or tests never ran", () => {
    expect(computeWarnings({ ...clean, testOutcome: "errored" })[0]).toMatch(/infrastructure error.*untested/);
    expect(computeWarnings({ ...clean, testOutcome: "not_run", totalTestCount: 0 })).toEqual([
      expect.stringMatching(/not been run.*untested/),
    ]);
  });

  it("accumulates multiple warnings", () => {
    expect(computeWarnings({ ...clean, authNeedsUserConfig: true, totalTestCount: 0 })).toHaveLength(2);
  });
});

describe("testOutcomeOf", () => {
  it("maps stored test statuses, treating none as not run", () => {
    expect(testOutcomeOf("passed")).toBe("passed");
    expect(testOutcomeOf("failed")).toBe("failed");
    expect(testOutcomeOf("errored")).toBe("errored");
    expect(testOutcomeOf("skipped")).toBe("not_run");
    expect(testOutcomeOf(undefined)).toBe("not_run");
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
