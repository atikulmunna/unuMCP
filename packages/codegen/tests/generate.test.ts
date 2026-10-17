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

describe("generateProject: untrusted text is escaped, not injected (P6-9, §18.4)", () => {
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

describe("generateProject: structure", () => {
  it("emits the expected project files (§12.4)", () => {
    expect([...fileMap(options).keys()]).toEqual([
      ".env.example",
      "package.json",
      "README.md",
      "src/client/apiClient.ts",
      "src/config/env.ts",
      "src/errors/ApiError.ts",
      "src/index.ts",
      "src/policy.ts",
      "src/schemas/createIssue.schema.ts",
      "src/server.ts",
      "src/tools/createIssue.ts",
      "tests/createIssue.test.ts",
      "tests/harness.ts",
      "tests/server.test.ts",
      "tsconfig.json",
    ]);
  });

  it("pins the MCP SDK and zod in package.json", () => {
    const pkg = JSON.parse(fileMap(options).get("package.json")!);
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe("1.32.1");
    expect(pkg.dependencies.zod).toBe("^3.25.0");
    expect(pkg.type).toBe("module");
  });
});

describe("generateProject: tool wiring", () => {
  const files = fileMap(options);

  it("substitutes path params via encodeURIComponent string concat", () => {
    const tool = files.get("src/tools/createIssue.ts")!;
    expect(tool).toContain(
      'const path = "/repos/" + encodeURIComponent(String(input["owner"])) + "/" + encodeURIComponent(String(input["repo"])) + "/issues";',
    );
    expect(tool).toContain(
      'return runTool(server, client, policy, createIssueMeta, {\n        method: "POST",\n        path,',
    );
    expect(tool).toContain("body: input.body");
  });

  it("registers through registerTool (the non-deprecated SDK API)", () => {
    const tool = files.get("src/tools/createIssue.ts")!;
    expect(tool).toContain(
      'server.registerTool(\n    "create_issue",\n    {\n      title: "Create issue",\n      description: "Create an issue in a repository.",',
    );
    expect(tool).toContain("inputSchema: createIssueInput.shape,");
    expect(tool).not.toContain("server.tool(");
  });

  it("registers each tool in the server factory, which the stdio entrypoint serves", () => {
    const server = files.get("src/server.ts")!;
    expect(server).toContain("  [createIssueMeta, registerCreateIssue],");
    expect(server).toContain("if (exposes(policy, meta)) register(server, client, policy);");
    expect(server).toContain('new McpServer({ name: "github-mcp-server", version: "0.1.0" })');
    const index = files.get("src/index.ts")!;
    expect(index).toContain("const server = createServer(\n  new ApiClient(");
    expect(index).toContain("  policyFromEnv(),\n);");
    expect(index).toContain("await server.connect(new StdioServerTransport());");
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
    // No unused z.infer type: Zod inference dominates typecheck memory on large servers.
    expect(schema).not.toContain("z.infer");
  });

  it("sends a non-JSON body with its media type (form bodies are form-encoded)", () => {
    const form = fileMap({ ...options, tools: [{ ...createIssue, bodyMediaType: "application/x-www-form-urlencoded" }] });
    expect(form.get("src/tools/createIssue.ts")).toContain('contentType: "application/x-www-form-urlencoded"');
    const client = form.get("src/client/apiClient.ts")!;
    expect(client).toContain('contentType === "application/x-www-form-urlencoded" ? formEncode(body) : JSON.stringify(body)');
    // Plain JSON bodies keep the default and pass no contentType.
    expect(files.get("src/tools/createIssue.ts")).not.toContain("contentType:");
  });

  it("sends header inputs as request headers, skipping unset ones", () => {
    const withHeader = fileMap({
      ...options,
      tools: [{ ...createIssue, parameters: [...createIssue.parameters, { name: "X-GitHub-Api-Version", in: "header" }] }],
    });
    const tool = withHeader.get("src/tools/createIssue.ts")!;
    expect(tool).toContain(
      'headers: {\n            "X-GitHub-Api-Version": input["X-GitHub-Api-Version"],\n          }',
    );
    const client = withHeader.get("src/client/apiClient.ts")!;
    expect(client).toContain("if (value !== undefined && value !== null) {\n        headers[key.toLowerCase()] = String(value);");
  });
});

describe("generateProject: risk-aware runtime", () => {
  const getIssue: McpToolDefinition = {
    ...createIssue,
    name: "get_issue",
    method: "get",
    pathTemplate: "/repos/{owner}/{repo}/issues/{n}",
    hasBody: false,
    riskLevel: "low",
  };
  const deleteRepo: McpToolDefinition = {
    ...createIssue,
    name: "delete_repo",
    method: "delete",
    pathTemplate: "/repos/{owner}/{repo}",
    hasBody: false,
    riskLevel: "critical",
  };
  const files = fileMap({ ...options, tools: [createIssue, getIssue, deleteRepo] });

  it("gives each tool MCP behavior hints that match its method and risk", () => {
    expect(files.get("src/tools/getIssue.ts")).toContain(
      'annotations: {"readOnlyHint":true,"openWorldHint":true},',
    );
    expect(files.get("src/tools/createIssue.ts")).toContain(
      'annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},',
    );
    expect(files.get("src/tools/deleteRepo.ts")).toContain(
      'annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},',
    );
  });

  it("records what the policy needs to know about each tool", () => {
    expect(files.get("src/tools/getIssue.ts")).toContain(
      'export const getIssueMeta: ToolMeta = {"name":"get_issue","readOnly":true,"riskLevel":"low"};',
    );
    expect(files.get("src/tools/deleteRepo.ts")).toContain('"readOnly":false,"riskLevel":"critical"');
  });

  it("tests approval only for risky tools, and that dry runs hold back only tools that change data", () => {
    const risky = files.get("tests/deleteRepo.test.ts")!;
    expect(risky).toContain("expect(api.approvals).toHaveLength(1);");
    expect(risky).toContain('it("sends nothing when the user declines"');
    expect(risky).toContain('it("sends nothing when the client can\'t ask the user"');
    expect(risky).toContain('it("in a dry run, returns the request it would send and sends nothing"');

    const medium = files.get("tests/createIssue.test.ts")!;
    expect(medium).toContain("expect(api.approvals).toHaveLength(0);");
    expect(medium).not.toContain("the user declines");
    expect(medium).toContain("in a dry run");

    const read = files.get("tests/getIssue.test.ts")!;
    expect(read).not.toContain("returns the request it would send");
    expect(read).toContain('it("still calls the API in a dry run, since it can\'t change anything"');
  });

  it("checks read-only mode against the GET tools in the server test", () => {
    const serverTest = files.get("tests/server.test.ts")!;
    expect(serverTest).toContain('const READ_ONLY: string[] = ["get_issue"];');
    expect(serverTest).toContain("in read-only mode");
    // Without a read-only tool there is nothing for read-only mode to list.
    const noReads = fileMap({ ...options, tools: [createIssue] }).get("tests/server.test.ts")!;
    expect(noReads).not.toContain("in read-only mode");
  });

  it("documents the safety controls and lists each tool's risk", () => {
    const readme = files.get("README.md")!;
    expect(readme).toContain("## Safety controls");
    expect(readme).toContain("| `MCP_CONFIRM_RISK` | `high` |");
    expect(readme).toContain("Risk: critical (can change data; asks for approval by default).");
    expect(readme).toContain("Risk: low (read-only).");
    expect(files.get(".env.example")).toContain("MCP_READ_ONLY=false\n");
    expect(files.get(".env.example")).toContain("MCP_CONFIRM_RISK=high\n");
  });

  it("asks the user through MCP elicitation and refuses without it", () => {
    const policy = files.get("src/policy.ts")!;
    expect(policy).toContain("server.server.getClientCapabilities()?.elicitation?.form");
    expect(policy).toContain("server.server.elicitInput({");
    expect(policy).toContain('if (answer.action === "accept" && answer.content?.confirm === true) return null;');
  });
});

describe("generateProject: determinism", () => {
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
