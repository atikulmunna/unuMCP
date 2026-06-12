import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@unumcp/openapi";
import { generateProject } from "../src/generate";
import type { GenerateOptions, McpToolDefinition } from "../src/types";

const createIssue: McpToolDefinition = {
  name: "create_issue",
  description: "Create an issue in a repository.",
  method: "post",
  pathTemplate: "/repos/{owner}/{repo}/issues",
  parameters: [
    { name: "owner", in: "path" },
    { name: "repo", in: "path" },
  ],
  hasBody: true,
  authRequired: true,
  riskLevel: "medium",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      body: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
    required: ["owner", "repo", "body"],
  } as JsonSchema,
};

const options: GenerateOptions = {
  serverName: "github-mcp-server",
  displayName: "GitHub MCP Server",
  baseUrl: "https://api.github.com",
  auth: { type: "bearer", envVar: "GITHUB_TOKEN" },
  tools: [createIssue],
};

function fileMap(opts: GenerateOptions): Map<string, string> {
  return new Map(generateProject(opts).map((f) => [f.path, f.content]));
}

describe("generateProject — untrusted text is escaped, not injected (P6-9, §18.4)", () => {
  // A description carrying a code-breakout attempt (unescaped quotes + a real newline).
  const evilDescription = '"); process.exit(1); globalThis.pwned = true; ("\nsecond line';
  const evilTool: McpToolDefinition = {
    name: "get_thing",
    description: evilDescription,
    method: "get",
    // A path parameter whose name also tries to break out of the string context.
    pathTemplate: '/things/{id"); evil(}',
    parameters: [{ name: 'id"); evil(', in: "path" }],
    hasBody: false,
    authRequired: false,
    riskLevel: "low",
    inputSchema: { type: "object", properties: {}, required: [] } as JsonSchema,
  };
  const files = fileMap({
    serverName: "x-mcp-server",
    baseUrl: "https://api.example.com",
    auth: { type: "none" },
    tools: [evilTool],
  });
  const toolFile = files.get("src/tools/getThing.ts") ?? "";

  it("embeds the description as an escaped JSON string literal", () => {
    expect(toolFile).toContain(JSON.stringify(evilDescription));
    // The raw, unescaped payload (with its real newline) must not appear in code.
    expect(toolFile).not.toContain(evilDescription);
  });

  it("escapes a malicious path-parameter name", () => {
    expect(toolFile).toContain(JSON.stringify('id"); evil('));
    // No unescaped breakout sequence sitting in code.
    expect(toolFile).not.toContain('"); evil(}');
  });
});

describe("generateProject — structure", () => {
  it("emits the expected project files (§12.4)", () => {
    const paths = new Set(fileMap(options).keys());
    for (const expected of [
      "package.json",
      "tsconfig.json",
      "README.md",
      ".env.example",
      "src/index.ts",
      "src/config/env.ts",
      "src/client/apiClient.ts",
      "src/errors/ApiError.ts",
      "src/errors/ToolError.ts",
      "src/schemas/createIssue.schema.ts",
      "src/tools/createIssue.ts",
      "tests/createIssue.test.ts",
    ]) {
      expect(paths.has(expected)).toBe(true);
    }
  });

  it("pins the MCP SDK and zod in package.json", () => {
    const pkg = JSON.parse(fileMap(options).get("package.json")!);
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe("1.29.0");
    expect(pkg.dependencies.zod).toBe("^3.25.0");
    expect(pkg.type).toBe("module");
  });
});

describe("generateProject — tool wiring", () => {
  const files = fileMap(options);

  it("substitutes path params via encodeURIComponent string concat", () => {
    const tool = files.get("src/tools/createIssue.ts")!;
    expect(tool).toContain(
      'const path = "/repos/" + encodeURIComponent(String(input["owner"])) + "/" + encodeURIComponent(String(input["repo"])) + "/issues";',
    );
    expect(tool).toContain('client.request("POST", path');
    expect(tool).toContain("body: input.body");
  });

  it("registers each tool in the entrypoint", () => {
    const index = files.get("src/index.ts")!;
    expect(index).toContain("registerCreateIssue(server, client);");
    expect(index).toContain('new McpServer({ name: "github-mcp-server", version: "0.1.0" })');
  });

  it("injects bearer auth in the API client", () => {
    const client = files.get("src/client/apiClient.ts")!;
    expect(client).toContain('headers["authorization"] = "Bearer " + this.opts.apiKey;');
  });

  it("loads the configured auth env var", () => {
    const env = files.get("src/config/env.ts")!;
    expect(env).toContain('process.env["GITHUB_TOKEN"]');
    expect(env).toContain('process.env["API_BASE_URL"] ?? "https://api.github.com"');
  });

  it("emits a Zod schema with the tool shape", () => {
    const schema = files.get("src/schemas/createIssue.schema.ts")!;
    expect(schema).toContain("export const createIssueInput = z.object({");
    expect(schema).toContain("export type CreateIssueInput = z.infer<typeof createIssueInput>;");
  });
});

describe("generateProject — determinism", () => {
  it("produces byte-identical output across runs", () => {
    expect(JSON.stringify(generateProject(options))).toBe(
      JSON.stringify(generateProject(options)),
    );
  });

  it("omits auth wiring when auth is none", () => {
    const files = fileMap({ ...options, auth: { type: "none" } });
    expect(files.get("src/client/apiClient.ts")!).not.toContain("authorization");
    // The Config interface still declares optional apiKey, but loadConfig must not populate it.
    expect(files.get("src/config/env.ts")!).not.toContain("apiKey: process.env");
  });
});
