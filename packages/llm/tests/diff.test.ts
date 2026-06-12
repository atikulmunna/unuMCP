import { describe, expect, it } from "vitest";
import { diffLines, unifiedDiff } from "../src/diff";

describe("diffLines", () => {
  it("returns no edits for identical text", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("captures a single changed line as a del + add", () => {
    const edits = diffLines("a\nb\nc", "a\nB\nc");
    expect(edits).toEqual([
      { type: "del", text: "b" },
      { type: "add", text: "B" },
    ]);
  });

  it("captures pure insertions and deletions", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([{ type: "add", text: "b" }]);
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([{ type: "del", text: "b" }]);
  });
});

describe("unifiedDiff", () => {
  it("renders a file header plus only the changed lines", () => {
    const diff = unifiedDiff("if (response.ok) {", "if (!response.ok) {", "src/client/apiClient.ts");
    expect(diff).toBe(
      [
        "--- a/src/client/apiClient.ts",
        "+++ b/src/client/apiClient.ts",
        "-if (response.ok) {",
        "+if (!response.ok) {",
      ].join("\n"),
    );
  });

  it("is empty for an unchanged file", () => {
    expect(unifiedDiff("same\ntext", "same\ntext", "x.ts")).toBe("");
  });
});
