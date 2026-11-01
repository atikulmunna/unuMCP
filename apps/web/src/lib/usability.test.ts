import { describe, expect, it } from "vitest";
import { fixImpact, usabilityScoreLine } from "./usability";

const run = { taskCount: 40, answeredCount: 40, baselineCorrect: 33, fixedCorrect: 38 };

describe("usabilityScoreLine", () => {
  it("states the score before and with the suggested fixes", () => {
    expect(usabilityScoreLine(run)).toBe(
      "Agents chose the right tool for 33 of 40 tasks (83%). With the suggested fixes: 38 of 40 (95%).",
    );
  });

  it("leaves out the fixes when none are offered", () => {
    expect(usabilityScoreLine({ ...run, fixedCorrect: null })).toBe(
      "Agents chose the right tool for 33 of 40 tasks (83%).",
    );
  });

  it("counts unanswered tasks separately, outside the score", () => {
    expect(usabilityScoreLine({ taskCount: 10, answeredCount: 8, baselineCorrect: 8, fixedCorrect: null })).toBe(
      "Agents chose the right tool for 8 of 8 tasks (100%). 2 tasks got no answer and are not counted.",
    );
    expect(usabilityScoreLine({ taskCount: 5, answeredCount: 4, baselineCorrect: 2, fixedCorrect: null })).toBe(
      "Agents chose the right tool for 2 of 4 tasks (50%). 1 task got no answer and is not counted.",
    );
  });

  it("never divides by zero", () => {
    expect(usabilityScoreLine({ taskCount: 0, answeredCount: 0, baselineCorrect: 0, fixedCorrect: null })).toBe(
      "Agents chose the right tool for 0 of 0 tasks (0%).",
    );
  });
});

describe("fixImpact", () => {
  it("counts the misses a fix repairs", () => {
    expect(fixImpact({ missesFixed: 1, pairedWith: [] })).toBe("fixes 1 miss");
    expect(fixImpact({ missesFixed: 3, pairedWith: [] })).toBe("fixes 3 misses");
  });

  it("names the fixes it was written with, and drops a zero count", () => {
    expect(fixImpact({ missesFixed: 1, pairedWith: ["fetch_entries"] })).toBe("fixes 1 miss · goes with fetch_entries");
    expect(fixImpact({ missesFixed: 0, pairedWith: ["get_entries"] })).toBe("goes with get_entries");
    expect(fixImpact({ missesFixed: 0, pairedWith: ["a", "b", "c"] })).toBe("goes with a, b and c");
  });
});
