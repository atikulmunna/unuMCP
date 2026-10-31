import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { dereferenceSpec, hasUnresolvedRef } from "../src/dereference";

const baseInfo = { title: "Test", version: "1.0.0" };

describe("dereferenceSpec", () => {
  it("resolves internal $ref so none remain downstream (OD-1)", async () => {
    const spec = {
      openapi: "3.0.3",
      info: baseInfo,
      paths: {
        "/users/{id}": {
          get: {
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
        },
      },
    };

    const deref = await dereferenceSpec(spec);
    expect(hasUnresolvedRef(deref)).toBe(false);

    const schema = (deref.paths["/users/{id}"] as any).get.responses["200"]
      .content["application/json"].schema;
    expect(schema.properties.id.type).toBe("string");
  });

  it("preserves circular references without infinite looping", async () => {
    const spec = {
      openapi: "3.0.3",
      info: baseInfo,
      paths: {},
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              children: {
                type: "array",
                items: { $ref: "#/components/schemas/Node" },
              },
            },
          },
        },
      },
    };

    const deref = await dereferenceSpec(spec);
    expect(hasUnresolvedRef(deref)).toBe(false);

    const node = (deref.components!.schemas!.Node as any);
    // The cycle is preserved as a real object reference.
    expect(node.properties.children.items).toBe(node);
  });

  it("does not mutate the caller's input", async () => {
    const spec = {
      openapi: "3.0.3",
      info: baseInfo,
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/X" } },
                },
              },
            },
          },
        },
      },
      components: { schemas: { X: { type: "object" } } },
    };
    const before = JSON.stringify(spec);
    await dereferenceSpec(spec);
    expect(JSON.stringify(spec)).toBe(before);
  });
});

describe("dereferenceSpec with references outside the document", () => {
  it("never reads the server's files or fetches URLs for an uploaded spec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unumcp-ref-"));
    const secretFile = join(dir, "secret.env");
    writeFileSync(secretFile, "JWT_SECRET=do-not-leak\n");
    try {
      const spec = {
        openapi: "3.0.3",
        info: baseInfo,
        paths: {
          "/a": { get: { description: { $ref: secretFile.replaceAll("\\", "/") }, responses: {} } },
          "/b": { get: { description: { $ref: pathToFileURL(secretFile).href }, responses: {} } },
          // Port 9 refuses connections, so a fetch would fail the test fast.
          "/c": { get: { responses: { "200": { $ref: "http://127.0.0.1:9/schema.json" } } } },
        },
      };
      const deref = await dereferenceSpec(spec);
      expect(JSON.stringify(deref)).not.toContain("do-not-leak");
      expect((deref.paths["/c"] as any).get.responses["200"].$ref).toBe("http://127.0.0.1:9/schema.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hasUnresolvedRef", () => {
  it("detects a remaining $ref", () => {
    expect(hasUnresolvedRef({ a: { $ref: "#/x" } })).toBe(true);
  });

  it("returns false for ref-free objects", () => {
    expect(hasUnresolvedRef({ a: { type: "string" }, b: [1, 2, 3] })).toBe(false);
  });
});
