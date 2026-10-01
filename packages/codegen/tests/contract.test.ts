import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@unumcp/openapi";
import { contractCase, TEST_API_KEY } from "../src/contract";
import type { McpToolDefinition } from "../src/types";

function tool(partial: Partial<McpToolDefinition>): McpToolDefinition {
  return {
    name: "t",
    description: "d",
    method: "get",
    pathTemplate: "/x",
    parameters: [],
    hasBody: false,
    authRequired: false,
    riskLevel: "low",
    inputSchema: { type: "object", properties: {} } as JsonSchema,
    ...partial,
  };
}

const props = (properties: Record<string, unknown>) => ({ type: "object", properties }) as JsonSchema;

describe("contractCase", () => {
  it("fills the path template with percent-encoded example arguments", () => {
    const c = contractCase(
      tool({
        method: "delete",
        pathTemplate: "/repos/{owner}/{repo}/issues/{number}",
        parameters: [
          { name: "owner", in: "path" },
          { name: "repo", in: "path" },
          { name: "number", in: "path" },
        ],
        inputSchema: props({
          owner: { type: "string" },
          repo: { type: "string", enum: ["a b/c"] },
          number: { type: "integer" },
        }),
      }),
      { type: "none" },
    );
    expect(c.args).toEqual({ owner: "example", repo: "a b/c", number: 1 });
    expect(c.request).toMatchObject({ method: "DELETE", path: "/repos/example/a%20b%2Fc/issues/1" });
  });

  it("serializes query values per OpenAPI's default (form, explode)", () => {
    const c = contractCase(
      tool({
        parameters: [
          { name: "tags", in: "query" },
          { name: "page", in: "query" },
          { name: "filter", in: "query" },
        ],
        inputSchema: props({
          tags: { type: "array", items: { type: "string" } },
          page: { type: "integer" },
          filter: { type: "object", properties: { state: { type: "string" }, sort: { type: "string" } } },
        }),
      }),
      { type: "none" },
    );
    // Arrays get two items, so "repeat the key" can't be confused with "join the values".
    expect(c.args.tags).toEqual(["example", "example"]);
    expect(c.request.query).toEqual([
      ["tags", "example"],
      ["tags", "example"],
      ["page", "1"],
      ["state", "example"],
      ["sort", "example"],
    ]);
  });

  it("expects header inputs (lowercased) plus the auth header", () => {
    const headerTool = tool({ parameters: [{ name: "X-Api-Version", in: "header" }], inputSchema: props({ "X-Api-Version": { type: "string" } }) });
    expect(contractCase(headerTool, { type: "bearer", envVar: "T" }).request.headers).toEqual({
      "x-api-version": "example",
      authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(contractCase(headerTool, { type: "apiKeyHeader", envVar: "K", headerName: "X-API-Key" }).request.headers).toEqual({
      "x-api-version": "example",
      "x-api-key": TEST_API_KEY,
    });
    expect(contractCase(headerTool, { type: "none" }).request.headers).toEqual({ "x-api-version": "example" });
  });

  it("expects a JSON body by default and its own media type otherwise", () => {
    const bodyTool = (bodyMediaType?: string) =>
      tool({ method: "post", hasBody: true, bodyMediaType, inputSchema: props({ body: { type: "object", properties: { name: { type: "string" } } } }) });
    expect(contractCase(bodyTool(), { type: "none" }).request.body).toEqual({ contentType: "application/json", json: { name: "example" } });
    expect(contractCase(bodyTool("application/merge-patch+json"), { type: "none" }).request.body).toEqual({
      contentType: "application/merge-patch+json",
      json: { name: "example" },
    });
  });

  it("expects form bodies as bracket-nested pairs", () => {
    const c = contractCase(
      tool({
        method: "post",
        hasBody: true,
        bodyMediaType: "application/x-www-form-urlencoded",
        inputSchema: props({
          body: {
            type: "object",
            properties: {
              amount: { type: "integer" },
              metadata: { type: "object", properties: { order: { type: "string" } } },
              expand: { type: "array", items: { type: "string" } },
            },
          },
        }),
      }),
      { type: "none" },
    );
    expect(c.request.body).toEqual({
      contentType: "application/x-www-form-urlencoded",
      form: [
        ["amount", "1"],
        ["metadata[order]", "example"],
        ["expand[0]", "example"],
        ["expand[1]", "example"],
      ],
    });
  });

  it("expects no body when the tool has none", () => {
    expect(contractCase(tool({}), { type: "none" }).request.body).toBeUndefined();
  });
});
