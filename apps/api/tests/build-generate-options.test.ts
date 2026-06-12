import { describe, expect, it } from "vitest";
import { generateProject } from "@unumcp/codegen";
import type { DetectedAuth, ExtractedEndpoint } from "@unumcp/openapi";
import {
  buildGenerateOptions,
  toServerName,
  type ApprovedTool,
} from "../src/generation/build-generate-options";

const getEndpoint: ExtractedEndpoint = {
  method: "get",
  path: "/widgets/{id}",
  operationId: "getWidget",
  tags: [],
  parameters: [
    { name: "id", in: "path", required: true, schema: { type: "string" } },
    { name: "verbose", in: "query", required: false, schema: { type: "boolean" } },
  ],
  authRequired: true,
  deprecated: false,
};

const createEndpoint: ExtractedEndpoint = {
  method: "post",
  path: "/widgets",
  operationId: "createWidget",
  tags: [],
  parameters: [],
  requestSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  authRequired: true,
  deprecated: false,
};

const tools: ApprovedTool[] = [
  {
    name: "get_widget",
    description: "Fetch a widget.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, verbose: { type: "boolean" } },
      required: ["id"],
    },
    riskLevel: "low",
    endpoint: getEndpoint,
  },
  {
    name: "create_widget",
    description: "Create a widget (modifies data).",
    inputSchema: {
      type: "object",
      properties: { body: { type: "object", properties: { name: { type: "string" } } } },
      required: ["body"],
    },
    riskLevel: "medium",
    endpoint: createEndpoint,
  },
];

const bearerAuth: DetectedAuth = {
  required: true,
  assumed: false,
  needsUserConfig: false,
  schemes: [{ id: "bearerAuth", type: "http", httpScheme: "bearer" }],
};

describe("buildGenerateOptions", () => {
  it("maps approved tools + endpoints into codegen definitions", () => {
    const opts = buildGenerateOptions({
      serverName: "widgets-mcp-server",
      baseUrl: "https://api.widgets.test",
      auth: bearerAuth,
      tools,
    });

    expect(opts.tools).toHaveLength(2);
    const get = opts.tools.find((t) => t.name === "get_widget")!;
    expect(get.method).toBe("get");
    expect(get.pathTemplate).toBe("/widgets/{id}");
    expect(get.parameters).toEqual([
      { name: "id", in: "path" },
      { name: "verbose", in: "query" },
    ]);
    expect(get.hasBody).toBe(false);

    const create = opts.tools.find((t) => t.name === "create_widget")!;
    expect(create.hasBody).toBe(true);
    expect(create.parameters).toEqual([]);
  });

  it("derives a bearer auth config from a declared http scheme", () => {
    const opts = buildGenerateOptions({
      serverName: "x",
      baseUrl: "https://x.test",
      auth: bearerAuth,
      tools,
    });
    expect(opts.auth).toEqual({ type: "bearer", envVar: "API_TOKEN" });
  });

  it("derives an apiKey-header auth config when declared", () => {
    const opts = buildGenerateOptions({
      serverName: "x",
      baseUrl: "https://x.test",
      auth: {
        required: true,
        assumed: false,
        needsUserConfig: false,
        schemes: [{ id: "k", type: "apiKey", in: "header", paramName: "X-API-Key" }],
      },
      tools,
    });
    expect(opts.auth).toEqual({ type: "apiKeyHeader", envVar: "API_KEY", headerName: "X-API-Key" });
  });

  it("F-1: assumes bearer auth when the spec gives nothing usable", () => {
    const opts = buildGenerateOptions({
      serverName: "x",
      baseUrl: "https://x.test",
      auth: { required: true, assumed: true, needsUserConfig: true, schemes: [] },
      tools,
    });
    expect(opts.auth).toEqual({ type: "bearer", envVar: "API_TOKEN" });
  });

  it("emits no auth when neither the spec nor any tool requires it", () => {
    const opts = buildGenerateOptions({
      serverName: "x",
      baseUrl: "https://x.test",
      auth: { required: false, assumed: false, needsUserConfig: false, schemes: [] },
      tools: [{ ...tools[0]!, endpoint: { ...getEndpoint, authRequired: false } }],
    });
    expect(opts.auth).toEqual({ type: "none" });
  });

  it("P3-10: generation is byte-identical across runs", () => {
    const opts = buildGenerateOptions({
      serverName: "widgets-mcp-server",
      baseUrl: "https://api.widgets.test",
      auth: bearerAuth,
      tools,
    });
    const a = generateProject(opts);
    const b = generateProject(opts);
    expect(a).toEqual(b);
    // Same files, same content — a strong reproducibility signal (§9.7.0).
    expect(a.map((f) => f.path)).toEqual(b.map((f) => f.path));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("toServerName", () => {
  it("slugifies a project name into a valid package name", () => {
    expect(toServerName("My Widgets API!")).toBe("my-widgets-api-mcp-server");
    expect(toServerName("   ")).toBe("api-mcp-server");
  });
});
