import type { AuthConfig, GeneratedFile, McpToolDefinition, NormalizedOptions } from "./types";
import { isReadOnly, toCamel, toolAnnotations, toolTitle, toPascal } from "./helpers";
import { confirmsByDefault, contractCase, TEST_API_KEY } from "./contract";

// The generated contract tests: the shared harness, the server-level test,
// and one test file per tool.

/** Required inputs of a tool, sorted (the order a listing is compared in). */
function requiredInputs(tool: McpToolDefinition): string[] {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const properties = schema.properties ?? {};
  return [...new Set((schema.required ?? []).filter((name) => name in properties))].sort();
}

export function harnessFile(): GeneratedFile {
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

export function serverTestFile(o: NormalizedOptions): GeneratedFile {
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

export function testFile(tool: McpToolDefinition, auth: AuthConfig): GeneratedFile {
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
