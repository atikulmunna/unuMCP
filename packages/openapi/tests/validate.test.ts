import { describe, expect, it } from "vitest";
import { parseSpec, validateSpec, toCycleSafe } from "../src/validate";

describe("parseSpec", () => {
  it("parses JSON", () => {
    const r = parseSpec('{"openapi":"3.0.0","paths":{}}');
    expect(r.ok).toBe(true);
    expect(r.doc?.openapi).toBe("3.0.0");
  });

  it("parses YAML", () => {
    const r = parseSpec("openapi: 3.0.0\npaths: {}\n");
    expect(r.ok).toBe(true);
    expect(r.doc?.openapi).toBe("3.0.0");
  });

  it("rejects empty input", () => {
    expect(parseSpec("   ").ok).toBe(false);
  });

  it("rejects unparseable input", () => {
    const r = parseSpec("{ not: valid: json: : :");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("validateSpec", () => {
  it("flags a missing version", () => {
    const r = validateSpec({ paths: { "/x": {} } });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("version");
  });

  it("refuses Swagger 2.0 with conversion advice instead of misreading it", () => {
    const r = validateSpec({ swagger: "2.0", info: { title: "t", version: "1" }, paths: { "/x": {} } });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/Swagger 2\.0 specs aren't supported yet\. Convert it to OpenAPI 3/);
    expect(validateSpec({ openapi: "3.1.0", paths: { "/x": {} } }).valid).toBe(true);
  });

  it("flags a missing paths section", () => {
    const r = validateSpec({ openapi: "3.0.0" });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("paths");
  });

  it("flags an empty paths section", () => {
    const r = validateSpec({ openapi: "3.0.0", paths: {} });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("no API paths");
  });

  it("refuses references to other files or URLs and accepts internal ones", () => {
    const withRef = (ref: string) => ({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: { "/x": { get: { responses: { "200": { $ref: ref } } } } },
    });
    for (const ref of [
      "../../apps/api/.env",
      "file:///etc/passwd",
      "http://169.254.169.254/latest/meta-data/",
      "common.yaml#/components/schemas/Error",
    ]) {
      const r = validateSpec(withRef(ref));
      expect(r.valid).toBe(false);
      expect(r.errors.join(" ")).toContain(`References to other files or URLs aren't supported ("${ref}")`);
    }
    expect(validateSpec(withRef("#/components/responses/Ok")).valid).toBe(true);
  });

  it("names at most three external references, once each, and survives cycles", () => {
    const op = (ref: string) => ({ get: { responses: { "200": { $ref: ref } } } });
    const doc: Record<string, any> = {
      openapi: "3.0.3",
      paths: { "/a": op("a.yaml"), "/b": op("b.yaml"), "/c": op("a.yaml"), "/d": op("c.yaml"), "/e": op("d.yaml") },
    };
    doc.paths["/a"].self = doc.paths["/a"];
    const r = validateSpec(doc);
    expect(r.errors.join(" ")).toContain('("a.yaml", "b.yaml", "c.yaml" and 1 more)');
  });

  it("accepts a valid spec and extracts metadata", () => {
    const r = validateSpec({
      openapi: "3.0.3",
      info: { title: "Demo", version: "1.2.3" },
      servers: [{ url: "https://api.example.com" }],
      paths: { "/x": { get: {} } },
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.title).toBe("Demo");
    expect(r.version).toBe("1.2.3");
    expect(r.baseUrl).toBe("https://api.example.com");
  });
});

describe("toCycleSafe", () => {
  it("breaks circular references and stays JSON-stringifiable", () => {
    const node: Record<string, unknown> = { name: "n" };
    node.self = node;
    const safe = toCycleSafe(node);
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect((safe as any).self).toEqual({ $circular: true });
  });

  it("preserves non-circular shared references as full copies", () => {
    const shared = { a: 1 };
    const safe = toCycleSafe({ x: shared, y: shared });
    expect((safe as any).x).toEqual({ a: 1 });
    expect((safe as any).y).toEqual({ a: 1 });
  });
});
