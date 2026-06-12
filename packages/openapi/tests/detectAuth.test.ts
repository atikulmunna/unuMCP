import { describe, expect, it } from "vitest";
import type { OpenAPIV3 } from "openapi-types";
import { detectAuth } from "../src/detectAuth";

function doc(partial: Record<string, unknown>): OpenAPIV3.Document {
  return {
    openapi: "3.0.3",
    info: { title: "T", version: "1.0.0" },
    paths: {},
    ...partial,
  } as unknown as OpenAPIV3.Document;
}

describe("detectAuth", () => {
  it("detects a bearer http scheme with global security", () => {
    const result = detectAuth(
      doc({
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        },
      }),
    );
    expect(result.required).toBe(true);
    expect(result.assumed).toBe(false);
    expect(result.needsUserConfig).toBe(false);
    expect(result.schemes).toEqual([{ id: "bearerAuth", type: "http", httpScheme: "bearer" }]);
  });

  it("detects an apiKey header scheme with its parameter name", () => {
    const result = detectAuth(
      doc({
        security: [{ apiKey: [] }],
        components: {
          securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
        },
      }),
    );
    expect(result.schemes).toEqual([
      { id: "apiKey", type: "apiKey", in: "header", paramName: "X-API-Key" },
    ]);
    expect(result.required).toBe(true);
  });

  it("treats a declared scheme as required when only an operation references it", () => {
    const result = detectAuth(
      doc({
        components: { securitySchemes: { apiKey: { type: "apiKey", in: "query", name: "key" } } },
        paths: {
          "/things": {
            get: { security: [{ apiKey: [] }], responses: { "200": { description: "ok" } } },
          },
        },
      }),
    );
    expect(result.required).toBe(true);
    expect(result.needsUserConfig).toBe(false);
  });

  it("reports declared schemes but required:false when nothing references them", () => {
    const result = detectAuth(
      doc({
        components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
      }),
    );
    expect(result.required).toBe(false);
    expect(result.assumed).toBe(false);
    expect(result.schemes).toHaveLength(1);
  });

  it("F-1: assumes required and asks the user when no securitySchemes exist", () => {
    const result = detectAuth(doc({ components: {} }));
    expect(result.required).toBe(true);
    expect(result.assumed).toBe(true);
    expect(result.needsUserConfig).toBe(true);
    expect(result.schemes).toEqual([]);
  });

  it("F-1: also triggers when securitySchemes is present but empty (GitHub-style)", () => {
    const result = detectAuth(doc({ components: { securitySchemes: {} } }));
    expect(result.assumed).toBe(true);
    expect(result.needsUserConfig).toBe(true);
  });

  it("collects multiple schemes for the user to choose from", () => {
    const result = detectAuth(
      doc({
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
            oauth: { type: "oauth2", flows: {} },
          },
        },
      }),
    );
    expect(result.schemes.map((s) => s.id).sort()).toEqual(["bearerAuth", "oauth"]);
    expect(result.schemes.find((s) => s.id === "oauth")?.type).toBe("oauth2");
  });
});
