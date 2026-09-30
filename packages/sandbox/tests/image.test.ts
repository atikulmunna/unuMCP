import { describe, expect, it } from "vitest";
import { generateProject } from "@unumcp/codegen";
import { missingDependencies, SANDBOX_DEPENDENCIES, SANDBOX_IMAGE } from "../src/image";

describe("sandbox image", () => {
  it("is tagged by a content hash of its definition", () => {
    expect(SANDBOX_IMAGE).toMatch(/^unumcp-sandbox:[0-9a-f]{12}$/);
  });

  it("provides exactly the dependencies codegen's template declares (drift guard)", () => {
    const files = generateProject({
      serverName: "drift-mcp-server",
      baseUrl: "https://api.drift.test",
      auth: { type: "none" },
      tools: [],
    });
    const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).toEqual(SANDBOX_DEPENDENCIES);
  });
});

describe("missingDependencies", () => {
  it("accepts a project whose dependencies the image provides", () => {
    const pkg = { dependencies: { zod: "^3.25.0" }, devDependencies: { vitest: "^2.1.0" } };
    expect(missingDependencies(JSON.stringify(pkg))).toEqual([]);
  });

  it("flags extra packages and changed version specs", () => {
    const pkg = {
      dependencies: { zod: "^4.0.0", "left-pad": "1.0.0" },
      devDependencies: { vitest: "^2.1.0" },
    };
    expect(missingDependencies(JSON.stringify(pkg))).toEqual(["zod@^4.0.0", "left-pad@1.0.0"]);
  });

  it("flags an unparseable package.json", () => {
    expect(missingDependencies("{not json")).toEqual(["package.json (not valid JSON)"]);
  });
});
