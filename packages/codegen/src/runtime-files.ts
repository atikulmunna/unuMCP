import type { AuthConfig, GeneratedFile, NormalizedOptions } from "./types";
import { toCamel, toPascal } from "./helpers";
import { DEFAULT_CONFIRM_RISK } from "./contract";

// The generated server's shared runtime: config, API client, error type,
// safety policy, server factory, and stdio entry point.

export function envConfigFile(o: NormalizedOptions): GeneratedFile {
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

export function apiErrorFile(): GeneratedFile {
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

export function apiClientFile(auth: AuthConfig): GeneratedFile {
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

/**
 * The runtime safety layer every generated server carries: which tools to
 * expose (read-only mode, allow and deny lists), dry runs, and asking the user
 * (MCP elicitation) before a risky call. The tool code calls `runTool`, so a
 * policy decision can't be skipped by one tool.
 */
export function policyFile(): GeneratedFile {
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

export function serverFile(o: NormalizedOptions): GeneratedFile {
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

export function indexFile(): GeneratedFile {
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
