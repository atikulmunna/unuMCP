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
