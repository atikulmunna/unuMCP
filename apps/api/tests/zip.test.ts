import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createZip } from "../src/generation/zip";

const files = [
  { path: "src/index.ts", content: "console.log('hi');\n" },
  { path: "package.json", content: '{ "name": "x" }\n' },
  { path: ".env.example", content: "API_TOKEN=your_token_here\n" },
];

describe("createZip", () => {
  it("packs all files preserving their paths and contents", async () => {
    const buffer = await createZip(files);
    const zip = await JSZip.loadAsync(buffer);
    const paths = Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => f.name)
      .sort();
    expect(paths).toEqual([".env.example", "package.json", "src/index.ts"]);
    expect(await zip.file("src/index.ts")!.async("string")).toBe("console.log('hi');\n");
  });

  it("is deterministic — same files produce byte-identical archives", async () => {
    const a = await createZip(files);
    const b = await createZip([...files].reverse());
    expect(Buffer.compare(a, b)).toBe(0);
  });
});
