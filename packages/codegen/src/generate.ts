import { jsonSchemaToZod } from "@unumcp/schema-gen";
import type {
  AuthConfig,
  GeneratedFile,
  GenerateOptions,
  McpToolDefinition,
} from "./types";
import { isReadOnly, pathExpression, toCamel, toolAnnotations, toolTitle, toPascal } from "./helpers";
import { confirmsByDefault, contractCase, DEFAULT_CONFIRM_RISK, TEST_API_KEY } from "./contract";

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
    policyFile(),
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
      .map((p) => `            ${JSON.stringify(p.name)}: input[${JSON.stringify(p.name)}]`)
      .join(",\n");
    requestParts.push(`${location === "query" ? "query" : "headers"}: {\n${entries},\n          }`);
  }
  if (tool.hasBody) {
    requestParts.push("body: input.body");
    if (tool.bodyMediaType) requestParts.push(`contentType: ${JSON.stringify(tool.bodyMediaType)}`);
  }
  const plannedOptions =
    requestParts.length > 0
      ? `\n        options: {\n          ${requestParts.join(",\n          ")},\n        },`
      : "";
  const meta = { name: tool.name, readOnly: isReadOnly(tool), riskLevel: tool.riskLevel };

  const content = `import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ${camel}Input } from "../schemas/${camel}.schema.js";
import type { ApiClient } from "../client/apiClient.js";
import { runTool, type Policy, type ToolMeta } from "../policy.js";

export const ${camel}Meta: ToolMeta = ${JSON.stringify(meta)};

export function register${pascal}(server: McpServer, client: ApiClient, policy: Policy): void {
  server.registerTool(
    ${JSON.stringify(tool.name)},
    {
      title: ${JSON.stringify(toolTitle(tool.name))},
      description: ${JSON.stringify(tool.description)},
      inputSchema: ${camel}Input.shape,
      annotations: ${JSON.stringify(toolAnnotations(tool))},
    },
    async (args) => {
      const input = ${camel}Input.parse(args);
      const path = ${pathExpression(tool.pathTemplate)};
      return runTool(server, client, policy, ${camel}Meta, {
        method: ${JSON.stringify(tool.method.toUpperCase())},
        path,${plannedOptions}
      });
    },
  );
}
`;
  return { path: `src/tools/${camel}.ts`, content };
}

function serverFile(o: NormalizedOptions): GeneratedFile {
  const imports = o.tools
    .map(
      (t) =>
        `import { ${toCamel(t.name)}Meta, register${toPascal(t.name)} } from "./tools/${toCamel(t.name)}.js";`,
    )
    .join("\n");
  const entries = o.tools
    .map((t) => `  [${toCamel(t.name)}Meta, register${toPascal(t.name)}],`)
    .join("\n");
  const content = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "./client/apiClient.js";
import { checkToolNames, DEFAULT_POLICY, exposes, type Policy, type ToolMeta } from "./policy.js";
${imports}

type Register = (server: McpServer, client: ApiClient, policy: Policy) => void;

const TOOLS: Array<[ToolMeta, Register]> = [
${entries}
];

/**
 * The MCP server, talking to the API through \`client\`, with the tools the
 * policy exposes. Throws when the policy names a tool that doesn't exist.
 */
export function createServer(client: ApiClient, policy: Policy = DEFAULT_POLICY): McpServer {
  checkToolNames(policy, TOOLS.map(([meta]) => meta.name));
  const server = new McpServer({ name: ${JSON.stringify(o.serverName)}, version: "0.1.0" });
  for (const [meta, register] of TOOLS) {
    if (exposes(policy, meta)) register(server, client, policy);
  }
  return server;
}
`;
  return { path: "src/server.ts", content };
}

function indexFile(): GeneratedFile {
  const content = `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/env.js";
import { ApiClient } from "./client/apiClient.js";
import { policyFromEnv } from "./policy.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(
  new ApiClient({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
  policyFromEnv(),
);
await server.connect(new StdioServerTransport());
`;
  return { path: "src/index.ts", content };
}

/**
 * The runtime safety layer every generated server carries: which tools to
 * expose (read-only mode, allow and deny lists), dry runs, and asking the user
 * (MCP elicitation) before a risky call. The tool code calls `runTool`, so a
 * policy decision can't be skipped by one tool.
 */
function policyFile(): GeneratedFile {
  const content = `import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiClient, RequestOptions } from "./client/apiClient.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];

/** What the generator knows about a tool; fixed when the server is generated. */
export interface ToolMeta {
  name: string;
  /** GET or HEAD: calling it cannot change anything. */
  readOnly: boolean;
  riskLevel: RiskLevel;
}

/**
 * The server's safety controls, read from the environment at startup
 * (\`policyFromEnv\`). The defaults expose every tool and ask the user before
 * running a ${DEFAULT_CONFIRM_RISK}-risk or riskier one.
 */
export interface Policy {
  /** Expose only the tools that cannot change anything. */
  readOnly: boolean;
  /** When set, expose only these tools. */
  enabledTools?: ReadonlySet<string>;
  /** Never expose these tools. */
  disabledTools: ReadonlySet<string>;
  /** Tools that can change data return the request they would send, and send nothing. */
  dryRun: boolean;
  /** Ask the user before running a tool at or above this risk; null never asks. */
  confirmRisk: RiskLevel | null;
}

export const DEFAULT_POLICY: Policy = {
  readOnly: false,
  disabledTools: new Set(),
  dryRun: false,
  confirmRisk: ${JSON.stringify(DEFAULT_CONFIRM_RISK)},
};

/**
 * The policy from the environment. A value it can't parse stops the server:
 * a typo must never quietly switch a safety control off.
 */
export function policyFromEnv(env: Record<string, string | undefined> = process.env): Policy {
  const confirm = (env.MCP_CONFIRM_RISK ?? DEFAULT_POLICY.confirmRisk ?? "none").trim().toLowerCase();
  if (confirm !== "none" && !(RISK_LEVELS as readonly string[]).includes(confirm)) {
    throw new Error(
      "MCP_CONFIRM_RISK must be low, medium, high, critical or none, not " + JSON.stringify(env.MCP_CONFIRM_RISK),
    );
  }
  const enabledTools = toolNames(env.MCP_ENABLED_TOOLS);
  return {
    readOnly: flag(env, "MCP_READ_ONLY"),
    ...(enabledTools ? { enabledTools } : {}),
    disabledTools: toolNames(env.MCP_DISABLED_TOOLS) ?? new Set(),
    dryRun: flag(env, "MCP_DRY_RUN"),
    confirmRisk: confirm === "none" ? null : (confirm as RiskLevel),
  };
}

function flag(env: Record<string, string | undefined>, key: string): boolean {
  const value = (env[key] ?? "").trim().toLowerCase();
  if (value === "" || value === "false" || value === "0" || value === "no") return false;
  if (value === "true" || value === "1" || value === "yes") return true;
  throw new Error(key + " must be true or false, not " + JSON.stringify(env[key]));
}

function toolNames(value: string | undefined): Set<string> | undefined {
  const names = (value ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  return names.length > 0 ? new Set(names) : undefined;
}

/** Whether the policy lets the server expose this tool. */
export function exposes(policy: Policy, tool: ToolMeta): boolean {
  if (policy.readOnly && !tool.readOnly) return false;
  if (policy.enabledTools && !policy.enabledTools.has(tool.name)) return false;
  return !policy.disabledTools.has(tool.name);
}

/** Reject list entries that name no tool, so a misspelled name can't leave a tool exposed. */
export function checkToolNames(policy: Policy, known: readonly string[]): void {
  const names = new Set(known);
  const unknown = [...(policy.enabledTools ?? []), ...policy.disabledTools].filter((name) => !names.has(name));
  if (unknown.length > 0) {
    throw new Error("MCP_ENABLED_TOOLS or MCP_DISABLED_TOOLS names no such tool: " + unknown.join(", "));
  }
}

/** The HTTP request one tool call makes. */
export interface PlannedRequest {
  method: string;
  path: string;
  options?: RequestOptions;
}

/**
 * Run one tool call under the policy. In a dry run a tool that can change data
 * returns the request it would send. A tool at or above the confirmation risk
 * runs only after the user approves it; when the client can't ask the user,
 * it doesn't run.
 */
export async function runTool(
  server: McpServer,
  client: ApiClient,
  policy: Policy,
  tool: ToolMeta,
  planned: PlannedRequest,
): Promise<CallToolResult> {
  if (policy.dryRun && !tool.readOnly) {
    const request = { method: planned.method, path: planned.path, ...planned.options };
    return textResult({ dryRun: true, tool: tool.name, request });
  }
  if (policy.confirmRisk && RISK_LEVELS.indexOf(tool.riskLevel) >= RISK_LEVELS.indexOf(policy.confirmRisk)) {
    const refusal = await askUser(server, tool, planned);
    if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
  }
  return textResult(await client.request(planned.method, planned.path, planned.options));
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Ask the user to approve a call. Returns why it may not run, or null once approved. */
async function askUser(server: McpServer, tool: ToolMeta, planned: PlannedRequest): Promise<string | null> {
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    return (
      "Not run: " + tool.name + " is a " + tool.riskLevel + "-risk tool that needs the user's approval, " +
      "and this MCP client can't ask the user (it lacks elicitation support). " +
      "Whoever runs this server can change that with MCP_CONFIRM_RISK."
    );
  }
  const answer = await server.server.elicitInput({
    message: approvalMessage(tool, planned),
    requestedSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", title: "Run it", description: "Send this request to the API." },
      },
      required: ["confirm"],
    },
  });
  if (answer.action === "accept" && answer.content?.confirm === true) return null;
  return "Not run: the user did not approve " + tool.name + ". Don't retry it unless the user asks.";
}

/** What the user is asked to approve: the tool, its risk, and the exact request. */
function approvalMessage(tool: ToolMeta, planned: PlannedRequest): string {
  const lines = [
    "Allow " + tool.name + " (" + tool.riskLevel + " risk)?",
    planned.method + " " + planned.path,
  ];
  const query = Object.entries(planned.options?.query ?? {}).filter(([, value]) => value !== undefined && value !== null);
  if (query.length > 0) lines.push("Query: " + clip(JSON.stringify(Object.fromEntries(query))));
  if (planned.options?.body !== undefined) lines.push("Body: " + clip(JSON.stringify(planned.options.body)));
  return lines.join("\\n");
}

function clip(text: string): string {
  return text.length > 500 ? text.slice(0, 497) + "..." : text;
}
`;
  return { path: "src/policy.ts", content };
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
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";
import { ApiClient } from "../src/client/apiClient.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy.js";

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

type Register = (server: McpServer, client: ApiClient, policy: Policy) => void;
type Build = (client: ApiClient, policy: Policy) => McpServer;

/** A server factory exposing only the given tools (keeps each test file small). */
export function toolServer(...register: Register[]): Build {
  return (client, policy) => {
    const server = new McpServer({ name: "contract-test", version: "0.0.0" });
    for (const add of register) add(server, client, policy);
    return server;
  };
}

export interface ConnectOptions {
  /** Policy settings on top of the defaults. */
  policy?: Partial<Policy>;
  /** How the user answers a request to approve a call; "unsupported" is a client that can't ask. */
  user?: "approve" | "decline" | "unsupported";
}

/**
 * Connect a real MCP client to a server over an in-memory transport, with the
 * upstream API replaced by a stub that records each request and answers with
 * \`reply\`. The client answers approval requests as \`options.user\` says and
 * records each one. Nothing leaves the process.
 */
export async function connect(build: Build, reply: StubReply, options: ConnectOptions = {}) {
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
  const server = build(
    new ApiClient({ baseUrl: TEST_BASE_URL, apiKey: TEST_API_KEY }),
    { ...DEFAULT_POLICY, ...options.policy },
  );
  const user = options.user ?? "approve";
  const client = new Client(
    { name: "contract-test-client", version: "0.0.0" },
    user === "unsupported" ? {} : { capabilities: { elicitation: {} } },
  );
  /** The message of each approval request the user was shown. */
  const approvals: string[] = [];
  if (user !== "unsupported") {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      approvals.push(request.params.message);
      return user === "approve"
        ? { action: "accept" as const, content: { confirm: true } }
        : { action: "decline" as const };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    approvals,
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
    .map((t) => ({
      name: t.name,
      title: toolTitle(t.name),
      description: t.description,
      required: requiredInputs(t),
      annotations: toolAnnotations(t),
    }));
  const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
  // With no read-only tool, read-only mode exposes nothing and there's no list to check.
  const readOnlyTest =
    readOnly.length === 0
      ? ""
      : `
  it("in read-only mode, exposes only the tools that cannot change anything", async () => {
    const api = await connect(createServer, { status: 200, body: {} }, { policy: { readOnly: true } });
    try {
      const { tools } = await api.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(READ_ONLY);
    } finally {
      await api.close();
    }
  });
`;
  const content = `import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/client/apiClient.js";
import { DEFAULT_POLICY, policyFromEnv } from "../src/policy.js";
import { createServer } from "../src/server.js";
import { connect } from "./harness.js";

// Every tool the server must expose, with what an MCP client is told about it.
const TOOLS: Array<{
  name: string;
  title: string;
  description: string;
  required: string[];
  annotations: Record<string, boolean>;
}> = ${JSON.stringify(tools, null, 2)};

// The GET and HEAD tools, the only ones read-only mode may expose.
const READ_ONLY: string[] = ${JSON.stringify(readOnly)};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP server (contract)", () => {
  it("lists every tool with its description, required inputs and behavior hints", async () => {
    const api = await connect(createServer, { status: 200, body: {} });
    try {
      const { tools } = await api.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name));
      for (const expected of TOOLS) {
        const tool = tools.find((candidate) => candidate.name === expected.name);
        expect(tool?.title, expected.name).toBe(expected.title);
        expect(tool?.description, expected.name).toBe(expected.description);
        expect([...(tool?.inputSchema.required ?? [])].sort(), expected.name).toEqual(expected.required);
        expect(tool?.annotations, expected.name).toEqual(expected.annotations);
      }
    } finally {
      await api.close();
    }
  });
${readOnlyTest}
  it("exposes only the allowed tools, minus the disabled ones", async () => {
    const names = TOOLS.map((tool) => tool.name);
    const policy = { enabledTools: new Set(names.slice(0, 2)), disabledTools: new Set(names.slice(1, 2)) };
    const api = await connect(createServer, { status: 200, body: {} }, { policy });
    try {
      const { tools } = await api.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(names.slice(0, 1));
    } finally {
      await api.close();
    }
  });

  it("refuses to start when a tool list names a tool that doesn't exist", () => {
    const client = new ApiClient({ baseUrl: "https://example.test" });
    const policy = { ...DEFAULT_POLICY, disabledTools: new Set(["no_such_tool"]) };
    expect(() => createServer(client, policy)).toThrow(/no_such_tool/);
  });

  it("reads its safety controls from the environment and rejects values it can't parse", () => {
    expect(policyFromEnv({})).toEqual(DEFAULT_POLICY);
    expect(
      policyFromEnv({
        MCP_READ_ONLY: "true",
        MCP_DRY_RUN: "1",
        MCP_CONFIRM_RISK: "none",
        MCP_ENABLED_TOOLS: "a, b",
        MCP_DISABLED_TOOLS: "c",
      }),
    ).toEqual({
      readOnly: true,
      dryRun: true,
      confirmRisk: null,
      enabledTools: new Set(["a", "b"]),
      disabledTools: new Set(["c"]),
    });
    expect(() => policyFromEnv({ MCP_CONFIRM_RISK: "extreme" })).toThrow(/MCP_CONFIRM_RISK/);
    expect(() => policyFromEnv({ MCP_READ_ONLY: "ture" })).toThrow(/MCP_READ_ONLY/);
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
  const asksApproval = confirmsByDefault(tool);
  const approvalAssertions = asksApproval
    ? `      // A risky call runs only after the user approves the exact request.
      expect(api.approvals).toHaveLength(1);
      expect(api.approvals[0]).toContain(EXPECTED.method + " " + EXPECTED.path);
`
    : `      expect(api.approvals).toHaveLength(0);
`;
  const approvalTests = !asksApproval
    ? ""
    : `
  it("sends nothing when the user declines", async () => {
    const api = await connect(toolServer(${register}), { status: 200, body: {} }, { user: "decline" });
    try {
      const result = await api.client.callTool({ name: ${name}, arguments: ARGS });
      expect(result.isError).toBe(true);
      expect(api.approvals).toHaveLength(1);
      expect(api.requests).toHaveLength(0);
    } finally {
      await api.close();
    }
  });

  it("sends nothing when the client can't ask the user", async () => {
    const api = await connect(toolServer(${register}), { status: 200, body: {} }, { user: "unsupported" });
    try {
      const result = await api.client.callTool({ name: ${name}, arguments: ARGS });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("approval");
      expect(api.requests).toHaveLength(0);
    } finally {
      await api.close();
    }
  });
`;
  const dryRunTest = isReadOnly(tool)
    ? `
  it("still calls the API in a dry run, since it can't change anything", async () => {
    const api = await connect(toolServer(${register}), { status: 200, body: {} }, { policy: { dryRun: true } });
    try {
      const result = await api.client.callTool({ name: ${name}, arguments: ARGS });
      expect(result.isError ?? false, textOf(result)).toBe(false);
      expect(api.requests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
`
    : `
  it("in a dry run, returns the request it would send and sends nothing", async () => {
    const api = await connect(toolServer(${register}), { status: 200, body: {} }, { policy: { dryRun: true } });
    try {
      const result = await api.client.callTool({ name: ${name}, arguments: ARGS });
      expect(result.isError ?? false, textOf(result)).toBe(false);
      expect(api.requests).toHaveLength(0);
      expect(api.approvals).toHaveLength(0);
      expect(JSON.parse(textOf(result))).toMatchObject({
        dryRun: true,
        request: { method: EXPECTED.method, path: EXPECTED.path },
      });
    } finally {
      await api.close();
    }
  });
`;
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
${bodyAssertions}${approvalAssertions}      // The API's response comes back to the agent as-is.
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
${rejectsMissingInputs}${approvalTests}${dryRunTest}});
`;
  return { path: `tests/${camel}.test.ts`, content };
}

function readmeFile(o: NormalizedOptions): GeneratedFile {
  const toolList = o.tools
    .map((t) => {
      const kind = isReadOnly(t) ? "read-only" : "can change data";
      const approval = confirmsByDefault(t) ? "; asks for approval by default" : "";
      return `### ${t.name}\n\n${t.description}\n\nRisk: ${t.riskLevel} (${kind}${approval}).\n`;
    })
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
that calls missing required inputs are rejected, that risky calls wait for the
user's approval, and that dry runs send nothing. No network is used.

## Safety controls

Set these in the server's environment. A value the server can't parse stops it
at startup, so a typo never turns a control off.

| Variable | Default | Effect |
| --- | --- | --- |
| \`MCP_READ_ONLY\` | \`false\` | \`true\` exposes only the GET and HEAD tools. |
| \`MCP_ENABLED_TOOLS\` | (all) | Comma-separated tool names; when set, only these are exposed. |
| \`MCP_DISABLED_TOOLS\` | (none) | Comma-separated tool names never to expose. |
| \`MCP_DRY_RUN\` | \`false\` | \`true\` makes tools that can change data return the request they would send, and send nothing. Reads still run. |
| \`MCP_CONFIRM_RISK\` | \`${DEFAULT_CONFIRM_RISK}\` | Ask the user to approve a call at or above this risk (\`low\`, \`medium\`, \`high\`, \`critical\`), or \`none\`. |

Approval uses MCP elicitation: the client shows the user the tool, its risk and
the exact request. A client without elicitation support can't ask, so those
tools refuse to run there unless \`MCP_CONFIRM_RISK\` allows them. Each tool
also carries MCP behavior hints (\`readOnlyHint\`, \`destructiveHint\`,
\`idempotentHint\`) that clients can use for their own prompts.

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
  lines.push(
    "",
    "# Safety controls (see the README)",
    "MCP_READ_ONLY=false",
    "MCP_ENABLED_TOOLS=",
    "MCP_DISABLED_TOOLS=",
    "MCP_DRY_RUN=false",
    `MCP_CONFIRM_RISK=${DEFAULT_CONFIRM_RISK}`,
  );
  return { path: ".env.example", content: lines.join("\n") + "\n" };
}
