import { jsonSchemaToZod } from "@unumcp/schema-gen";
import type {
  AuthConfig,
  GeneratedFile,
  GenerateOptions,
  McpToolDefinition,
} from "./types";
import { pathExpression, toCamel, toPascal } from "./helpers";
import { contractCase, TEST_API_KEY } from "./contract";

const DEFAULT_MCP_SDK_VERSION = "1.29.0";
const DEFAULT_ZOD_VERSION = "^3.25.0";

/**
 * Deterministically generate a complete TypeScript MCP server project from a
 * set of tool definitions (FR-018, §12.4). Pure: same options → same files.
 *
 * The tests it emits are contract tests: each drives a tool through a real MCP
 * client (in-memory transport) with the upstream API stubbed, and asserts the
 * exact HTTP request the spec defines (see `contract.ts`).
 */
export function generateProject(options: GenerateOptions): GeneratedFile[] {
  const opts = normalize(options);
  const files: GeneratedFile[] = [
    packageJsonFile(opts),
    tsconfigFile(),
    envConfigFile(opts),
    apiErrorFile(),
    apiClientFile(opts.auth),
    serverFile(opts),
    indexFile(),
    readmeFile(opts),
    envExampleFile(opts),
    harnessFile(),
    serverTestFile(opts),
  ];
  for (const tool of opts.tools) {
    files.push(schemaFile(tool));
    files.push(toolFile(tool));
    files.push(testFile(tool, opts.auth));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

type NormalizedOptions = Required<Omit<GenerateOptions, "displayName">> & {
  displayName: string;
};

function normalize(o: GenerateOptions): NormalizedOptions {
  return {
    serverName: o.serverName,
    displayName: o.displayName ?? o.serverName,
    baseUrl: o.baseUrl,
    baseUrlEnvVar: o.baseUrlEnvVar ?? "API_BASE_URL",
    tools: o.tools,
    auth: o.auth,
    mcpSdkVersion: o.mcpSdkVersion ?? DEFAULT_MCP_SDK_VERSION,
    zodVersion: o.zodVersion ?? DEFAULT_ZOD_VERSION,
  };
}

function packageJsonFile(o: NormalizedOptions): GeneratedFile {
  const pkg = {
    name: o.serverName,
    version: "0.1.0",
    private: true,
    type: "module",
    bin: { [o.serverName]: "dist/index.js" },
    scripts: {
      build: "tsc",
      start: "node dist/index.js",
      dev: "tsx src/index.ts",
      test: "vitest run",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": o.mcpSdkVersion,
      zod: o.zodVersion,
    },
    devDependencies: {
      "@types/node": "^22.0.0",
      tsx: "^4.19.0",
      typescript: "^5.6.0",
      vitest: "^2.1.0",
    },
  };
  return { path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" };
}

function tsconfigFile(): GeneratedFile {
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
      rootDir: "src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: false,
    },
    include: ["src"],
  };
  return { path: "tsconfig.json", content: JSON.stringify(tsconfig, null, 2) + "\n" };
}

function envConfigFile(o: NormalizedOptions): GeneratedFile {
  const apiKeyLine =
    o.auth.type === "none"
      ? ""
      : `    apiKey: process.env[${JSON.stringify(o.auth.envVar)}],\n`;
  const content = `export interface Config {
  baseUrl: string;
  apiKey?: string;
}

export function loadConfig(): Config {
  return {
    baseUrl: process.env[${JSON.stringify(o.baseUrlEnvVar)}] ?? ${JSON.stringify(o.baseUrl)},
${apiKeyLine}  };
}
`;
  return { path: "src/config/env.ts", content };
}

function apiErrorFile(): GeneratedFile {
  const content = `export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super("API request failed with status " + status);
    this.name = "ApiError";
  }
}
`;
  return { path: "src/errors/ApiError.ts", content };
}

function authHeaderSnippet(auth: AuthConfig): string {
  switch (auth.type) {
    case "bearer":
      return `    if (this.opts.apiKey) {\n      headers["authorization"] = "Bearer " + this.opts.apiKey;\n    }\n`;
    case "apiKeyHeader":
      return `    if (this.opts.apiKey) {\n      headers[${JSON.stringify(
        auth.headerName.toLowerCase(),
      )}] = this.opts.apiKey;\n    }\n`;
    case "none":
      return "";
  }
}

function apiClientFile(auth: AuthConfig): GeneratedFile {
  const content = `import { ApiError } from "../errors/ApiError.js";

export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** Media type of \`body\`: JSON (the default), a +json type, or form-urlencoded. */
  contentType?: string;
  /** Header inputs; unset ones are skipped. */
  headers?: Record<string, unknown>;
}

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(path.replace(/^\\//, ""), this.opts.baseUrl.endsWith("/") ? this.opts.baseUrl : this.opts.baseUrl + "/");
    for (const [key, value] of Object.entries(options.query ?? {})) {
      appendQuery(url.searchParams, key, value);
    }
    const contentType = options.contentType ?? "application/json";
    const headers: Record<string, string> = { "content-type": contentType };
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined && value !== null) {
        headers[key.toLowerCase()] = String(value);
      }
    }
${authHeaderSnippet(auth)}    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : encodeBody(options.body, contentType),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30000),
    });
    const text = await response.text();
    const data = text.length > 0 ? safeJsonParse(text) : undefined;
    if (!response.ok) {
      throw new ApiError(response.status, data ?? text);
    }
    return data;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * OpenAPI's default query style (form, explode): an array repeats its key
 * (?tag=a&tag=b) and an object contributes one pair per property.
 */
function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== undefined && item !== null) params.append(key, String(item));
    }
  } else if (typeof value === "object") {
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined && item !== null) params.append(name, String(item));
    }
  } else {
    params.append(key, String(value));
  }
}

function encodeBody(body: unknown, contentType: string): string {
  return contentType === "application/x-www-form-urlencoded" ? formEncode(body) : JSON.stringify(body);
}

/** Form-urlencode a value, nesting with brackets: a[b]=1, list[0]=x. */
export function formEncode(value: unknown): string {
  const params = new URLSearchParams();
  const add = (key: string, item: unknown): void => {
    if (item === undefined || item === null) return;
    if (Array.isArray(item)) {
      item.forEach((entry, index) => add(key + "[" + index + "]", entry));
    } else if (typeof item === "object") {
      for (const [name, entry] of Object.entries(item as Record<string, unknown>)) {
        add(key ? key + "[" + name + "]" : name, entry);
      }
    } else {
      params.append(key, String(item));
    }
  };
  add("", value);
  return params.toString();
}
`;
  return { path: "src/client/apiClient.ts", content };
}

// No exported `z.infer` type alongside the schema: nothing uses it, and Zod
// type inference is the costliest part of typechecking a large server.
function schemaFile(tool: McpToolDefinition): GeneratedFile {
  const camel = toCamel(tool.name);
  const zod = jsonSchemaToZod(tool.inputSchema);
  const content = `import { z } from "zod";

export const ${camel}Input = ${zod};
`;
  return { path: `src/schemas/${camel}.schema.ts`, content };
}

function toolFile(tool: McpToolDefinition): GeneratedFile {
  const camel = toCamel(tool.name);
  const pascal = toPascal(tool.name);
  const requestParts: string[] = [];
  for (const location of ["query", "header"] as const) {
    const params = tool.parameters.filter((p) => p.in === location);
    if (params.length === 0) continue;
    const entries = params
      .map((p) => `        ${JSON.stringify(p.name)}: input[${JSON.stringify(p.name)}]`)
      .join(",\n");
    requestParts.push(`${location === "query" ? "query" : "headers"}: {\n${entries},\n      }`);
  }
  if (tool.hasBody) {
    requestParts.push("body: input.body");
    if (tool.bodyMediaType) requestParts.push(`contentType: ${JSON.stringify(tool.bodyMediaType)}`);
  }
  const requestOptions =
    requestParts.length > 0 ? `, {\n      ${requestParts.join(",\n      ")},\n    }` : "";

  const content = `import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ${camel}Input } from "../schemas/${camel}.schema.js";
import type { ApiClient } from "../client/apiClient.js";

export function register${pascal}(server: McpServer, client: ApiClient): void {
  server.registerTool(
    ${JSON.stringify(tool.name)},
    {
      description: ${JSON.stringify(tool.description)},
      inputSchema: ${camel}Input.shape,
    },
    async (args) => {
      const input = ${camel}Input.parse(args);
      const path = ${pathExpression(tool.pathTemplate)};
      const result = await client.request(${JSON.stringify(
        tool.method.toUpperCase(),
      )}, path${requestOptions});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
`;
  return { path: `src/tools/${camel}.ts`, content };
}

function serverFile(o: NormalizedOptions): GeneratedFile {
  const imports = o.tools
    .map((t) => `import { register${toPascal(t.name)} } from "./tools/${toCamel(t.name)}.js";`)
    .join("\n");
  const registrations = o.tools
    .map((t) => `  register${toPascal(t.name)}(server, client);`)
    .join("\n");
  const content = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "./client/apiClient.js";
${imports}

/** The MCP server with every tool registered, talking to the API through \`client\`. */
export function createServer(client: ApiClient): McpServer {
  const server = new McpServer({ name: ${JSON.stringify(o.serverName)}, version: "0.1.0" });
${registrations}
  return server;
}
`;
  return { path: "src/server.ts", content };
}

function indexFile(): GeneratedFile {
  const content = `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/env.js";
import { ApiClient } from "./client/apiClient.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(new ApiClient({ baseUrl: config.baseUrl, apiKey: config.apiKey }));
await server.connect(new StdioServerTransport());
`;
  return { path: "src/index.ts", content };
}

/** Required inputs of a tool, sorted (the order a listing is compared in). */
function requiredInputs(tool: McpToolDefinition): string[] {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const properties = schema.properties ?? {};
  return [...new Set((schema.required ?? []).filter((name) => name in properties))].sort();
}

function harnessFile(): GeneratedFile {
  const content = `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vi } from "vitest";
import { ApiClient } from "../src/client/apiClient.js";

/** Where the tests point the API client; the path prefix also exercises URL joining. */
const TEST_BASE_URL = "https://example.test/api/";
const TEST_API_KEY = ${JSON.stringify(TEST_API_KEY)};

export interface CapturedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface StubReply {
  status: number;
  body: unknown;
}

type Register = (server: McpServer, client: ApiClient) => void;

/** A server factory exposing only the given tools (keeps each test file small). */
export function toolServer(...register: Register[]): (client: ApiClient) => McpServer {
  return (client) => {
    const server = new McpServer({ name: "contract-test", version: "0.0.0" });
    for (const add of register) add(server, client);
    return server;
  };
}

/**
 * Connect a real MCP client to a server over an in-memory transport, with the
 * upstream API replaced by a stub that records each request and answers with
 * \`reply\`. Nothing leaves the process.
 */
export async function connect(build: (client: ApiClient) => McpServer, reply: StubReply) {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    requests.push({
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  const server = build(new ApiClient({ baseUrl: TEST_BASE_URL, apiKey: TEST_API_KEY }));
  const client = new Client({ name: "contract-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    /** The base URL's path prefix, which every request path must start with. */
    basePath: new URL(TEST_BASE_URL).pathname.replace(/\\/$/, ""),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The text of a tool result's first text block. */
export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((block) => block.type === "text")?.text ?? "";
}
`;
  return { path: "tests/harness.ts", content };
}

function serverTestFile(o: NormalizedOptions): GeneratedFile {
  const tools = [...o.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ name: t.name, description: t.description, required: requiredInputs(t) }));
  const content = `import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { connect } from "./harness.js";

// Every tool the server must expose, with its description and required inputs.
const TOOLS: Array<{ name: string; description: string; required: string[] }> = ${JSON.stringify(tools, null, 2)};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP server (contract)", () => {
  it("lists every tool with its description and required inputs", async () => {
    const api = await connect(createServer, { status: 200, body: {} });
    try {
      const { tools } = await api.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name));
      for (const expected of TOOLS) {
        const tool = tools.find((candidate) => candidate.name === expected.name);
        expect(tool?.description, expected.name).toBe(expected.description);
        expect([...(tool?.inputSchema.required ?? [])].sort(), expected.name).toEqual(expected.required);
      }
    } finally {
      await api.close();
    }
  });
});
`;
  return { path: "tests/server.test.ts", content };
}

function testFile(tool: McpToolDefinition, auth: AuthConfig): GeneratedFile {
  const camel = toCamel(tool.name);
  const register = `register${toPascal(tool.name)}`;
  const name = JSON.stringify(tool.name);
  const contract = contractCase(tool, auth);
  const body = contract.request.body;
  const bodyAssertions =
    body === undefined
      ? `      expect(request.body).toBeUndefined();\n`
      : `      expect(request.headers["content-type"]).toBe(EXPECTED.body.contentType);\n` +
        (body.form
          ? `      expect([...new URLSearchParams(request.body ?? "")]).toEqual(EXPECTED.body.form);\n`
          : `      expect(JSON.parse(request.body ?? "null")).toEqual(EXPECTED.body.json);\n`);
  const rejectsMissingInputs =
    requiredInputs(tool).length === 0
      ? ""
      : `
  it("rejects a call missing its required inputs, without calling the API", async () => {
    const api = await connect(toolServer(${register}), { status: 200, body: {} });
    try {
      const result = await api.client.callTool({ name: ${name}, arguments: {} });
      expect(result.isError).toBe(true);
      expect(api.requests).toHaveLength(0);
    } finally {
      await api.close();
    }
  });
`;

  const content = `import { afterEach, describe, expect, it, vi } from "vitest";
import { ${register} } from "../src/tools/${camel}.js";
import { connect, textOf, toolServer } from "./harness.js";

// The arguments these tests call the tool with, and the HTTP request the API
// spec says they must produce. Derived from the spec (path template, parameter
// locations, media type, auth), not from the tool's code.
const ARGS = ${JSON.stringify(contract.args, null, 2)};
const EXPECTED = ${JSON.stringify(contract.request, null, 2)};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(${JSON.stringify(`${tool.name} (contract)`)}, () => {
  it("sends the HTTP request the API spec defines", async () => {
    const api = await connect(toolServer(${register}), { status: 200, body: { sample: ${name} } });
    try {
      const result = await api.client.callTool({ name: ${name}, arguments: ARGS });
      expect(result.isError ?? false, textOf(result)).toBe(false);
      expect(api.requests).toHaveLength(1);
      const request = api.requests[0]!;
      expect(request.method).toBe(EXPECTED.method);
      expect(request.url.pathname).toBe(api.basePath + EXPECTED.path);
      expect([...request.url.searchParams]).toEqual(EXPECTED.query);
      for (const [header, value] of Object.entries(EXPECTED.headers)) {
        expect(request.headers[header], header).toBe(value);
      }
${bodyAssertions}      // The API's response comes back to the agent as-is.
      expect(JSON.parse(textOf(result))).toEqual({ sample: ${name} });
    } finally {
      await api.close();
    }
  });

  it("reports an API error to the agent as a tool error", async () => {
    const api = await connect(toolServer(${register}), { status: 404, body: { message: "Not Found" } });
    try {
      const result = await api.client.callTool({ name: ${name}, arguments: ARGS });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("404");
    } finally {
      await api.close();
    }
  });
${rejectsMissingInputs}});
`;
  return { path: `tests/${camel}.test.ts`, content };
}

function readmeFile(o: NormalizedOptions): GeneratedFile {
  const toolList = o.tools
    .map((t) => `### ${t.name}\n\n${t.description}\n`)
    .join("\n");
  const envVar = o.auth.type === "none" ? "" : `${o.auth.envVar}=your_token_here\n`;
  const content = `# ${o.displayName}

An MCP server generated by unuMCP that exposes selected tools for the target API.

## Installation

\`\`\`bash
npm install
\`\`\`

## Configuration

Create a \`.env\` file:

\`\`\`env
${o.baseUrlEnvVar}=${o.baseUrl}
${envVar}\`\`\`

## Development

\`\`\`bash
npm run dev
\`\`\`

## Testing

\`\`\`bash
npm run typecheck
npm test
\`\`\`

The tests are contract tests: each tool is called through a real MCP client
(in-memory transport) with the API stubbed, and the test checks the exact HTTP
request the API spec defines (method, path, query, headers, auth, body), that
the response reaches the agent unchanged, that API errors become tool errors,
and that calls missing required inputs are rejected. No network is used.

## Available Tools

${toolList}
## Security Notes

- Secrets are loaded from environment variables; do not commit \`.env\`.
- This server was generated automatically. Review tool behavior before production use.
`;
  return { path: "README.md", content };
}

function envExampleFile(o: NormalizedOptions): GeneratedFile {
  const lines = [`${o.baseUrlEnvVar}=${o.baseUrl}`];
  if (o.auth.type !== "none") lines.push(`${o.auth.envVar}=your_token_here`);
  return { path: ".env.example", content: lines.join("\n") + "\n" };
}
