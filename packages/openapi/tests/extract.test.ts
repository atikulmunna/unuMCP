import { describe, expect, it } from "vitest";
import type { OpenAPIV3 } from "openapi-types";
import { dereferenceSpec } from "../src/dereference";
import { extractEndpoints } from "../src/extract";

const demoSpec = {
  openapi: "3.0.3",
  info: { title: "Demo", version: "1.0.0" },
  security: [{ apiKey: [] }],
  paths: {
    "/users/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      get: {
        operationId: "getUser",
        summary: "Get a user",
        tags: ["users"],
        parameters: [
          { name: "fields", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "object", properties: { id: { type: "string" } } },
              },
            },
          },
        },
      },
      delete: {
        operationId: "deleteUser",
        deprecated: true,
        security: [],
        responses: { "204": { description: "no content" } },
      },
    },
    "/users": {
      post: {
        operationId: "createUser",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};

const FORM = "application/x-www-form-urlencoded";

function getEndpoint(doc: OpenAPIV3.Document, method: string, path: string) {
  const endpoints = extractEndpoints(doc);
  const found = endpoints.find((e) => e.method === method && e.path === path);
  if (!found) throw new Error(`missing ${method} ${path}`);
  return found;
}

describe("extractEndpoints", () => {
  const doc = demoSpec as unknown as OpenAPIV3.Document;

  it("extracts every operation", () => {
    expect(extractEndpoints(doc)).toHaveLength(3);
  });

  it("merges path-level and operation-level parameters", () => {
    const getUser = getEndpoint(doc, "get", "/users/{id}");
    const names = getUser.parameters.map((p) => p.name).sort();
    expect(names).toEqual(["fields", "id"]);
    expect(getUser.parameters.find((p) => p.name === "id")?.required).toBe(true);
    expect(getUser.parameters.find((p) => p.name === "fields")?.required).toBe(false);
  });

  it("inherits global security but honors an explicit opt-out", () => {
    expect(getEndpoint(doc, "get", "/users/{id}").authRequired).toBe(true);
    expect(getEndpoint(doc, "delete", "/users/{id}").authRequired).toBe(false);
  });

  it("flags deprecated operations", () => {
    expect(getEndpoint(doc, "delete", "/users/{id}").deprecated).toBe(true);
    expect(getEndpoint(doc, "get", "/users/{id}").deprecated).toBe(false);
  });

  it("captures request and response schemas", () => {
    const createUser = getEndpoint(doc, "post", "/users");
    expect((createUser.requestSchema as any).required).toEqual(["name"]);
    expect(createUser.requestMediaType).toBe("application/json");
    const getUser = getEndpoint(doc, "get", "/users/{id}");
    expect((getUser.responseSchema as any).properties.id.type).toBe("string");
  });

  describe("request body media types", () => {
    const bodyOf = (content: Record<string, unknown>) =>
      getEndpoint(
        {
          openapi: "3.0.3",
          info: { title: "t", version: "1" },
          paths: { "/x": { post: { requestBody: { content }, responses: { "200": { description: "ok" } } } } },
        } as unknown as OpenAPIV3.Document,
        "post",
        "/x",
      );
    const obj = { schema: { type: "object", properties: { a: { type: "string" } } } };

    it("prefers JSON, then a +json vendor type, then form-urlencoded", () => {
      expect(bodyOf({ [FORM]: obj, "application/json": obj }).requestMediaType).toBe("application/json");
      expect(bodyOf({ [FORM]: obj, "application/vnd.api+json": obj }).requestMediaType).toBe("application/vnd.api+json");
      expect(bodyOf({ "multipart/form-data": obj, [FORM]: obj }).requestMediaType).toBe(FORM);
    });

    it("ignores media type parameters and still reads the schema", () => {
      const e = bodyOf({ "application/json; charset=utf-8": obj });
      expect(e.requestMediaType).toBe("application/json");
      expect((e.requestSchema as any).properties.a.type).toBe("string");
    });

    it("accepts a supported body declared without a schema (any value)", () => {
      expect(bodyOf({ "application/json": {} }).requestSchema).toEqual({});
    });

    it("reports a body it can't send instead of silently dropping it", () => {
      const e = bodyOf({ "multipart/form-data": obj, "application/octet-stream": {} });
      expect(e.requestSchema).toBeUndefined();
      expect(e.unsupportedRequestBody).toBe("multipart/form-data, application/octet-stream");
    });
  });

  it("works end-to-end on a $ref-laden spec after dereferencing", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Ref", version: "1.0.0" },
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Item" } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Item: { type: "object", properties: { sku: { type: "string" } } },
        },
      },
    };
    const deref = await dereferenceSpec(spec);
    const listItems = getEndpoint(deref, "get", "/items");
    expect((listItems.responseSchema as any).properties.sku.type).toBe("string");
  });
});
