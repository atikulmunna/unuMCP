import { describe, expect, it } from "vitest";
import { diffToLines, fileLanguage } from "./preview";

describe("diffToLines", () => {
  it("returns nothing for an empty diff", () => {
    expect(diffToLines("")).toEqual([]);
  });

  it("classifies headers as meta, not as additions/deletions", () => {
    const diff = ["--- a/src/index.ts", "+++ b/src/index.ts", "-old line", "+new line", " unchanged"].join("\n");
    expect(diffToLines(diff)).toEqual([
      { tone: "meta", text: "--- a/src/index.ts" },
      { tone: "meta", text: "+++ b/src/index.ts" },
      { tone: "del", text: "-old line" },
      { tone: "add", text: "+new line" },
      { tone: "context", text: " unchanged" },
    ]);
  });

  it("treats a hunk marker as meta", () => {
    expect(diffToLines("@@ -1 +1 @@")[0]).toEqual({ tone: "meta", text: "@@ -1 +1 @@" });
  });
});

describe("fileLanguage", () => {
  it("labels known extensions", () => {
    expect(fileLanguage("src/index.ts")).toBe("TypeScript");
    expect(fileLanguage("package.json")).toBe("JSON");
    expect(fileLanguage("README.md")).toBe("Markdown");
    expect(fileLanguage(".env.example")).toBe("dotenv");
  });

  it("falls back to Text for unknown extensions", () => {
    expect(fileLanguage("Dockerfile")).toBe("Text");
  });
});
