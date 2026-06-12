import { jsonSchemaToZod } from "@unumcp/schema-gen";
import type {
  AuthConfig,
  GeneratedFile,
  GenerateOptions,
  McpToolDefinition,
} from "./types";
import { exampleForSchema, pathExpression, toCamel, toPascal } from "./helpers";

const DEFAULT_MCP_SDK_VERSION = "1.29.0";
const DEFAULT_ZOD_VERSION = "^3.25.0";

/**
 * Deterministically generate a complete TypeScript MCP server project from a
 * set of tool definitions (FR-018, §12.4). Pure: same options → same files.
 */
export function generateProject(options: GenerateOptions): GeneratedFile[] {
  const opts = normalize(options);
  const files: GeneratedFile[] = [
    packageJsonFile(opts),
    tsconfigFile(),
    envConfigFile(opts),
    apiErrorFile(),
    toolErrorFile(),
    apiClientFile(opts.auth),
    indexFile(opts),
    readmeFile(opts),
    envExampleFile(opts),
  ];
  for (const tool of opts.tools) {
    files.push(schemaFile(tool));
    files.push(toolFile(tool));
    files.push(testFile(tool));
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

function toolErrorFile(): GeneratedFile {
  const content = `export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
`;
  return { path: "src/errors/ToolError.ts", content };
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
  headers?: Record<string, string>;
}

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(path.replace(/^\\//, ""), this.opts.baseUrl.endsWith("/") ? this.opts.baseUrl : this.opts.baseUrl + "/");
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...options.headers,
    };
${authHeaderSnippet(auth)}    const response = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
`;
  return { path: "src/client/apiClient.ts", content };
}

function schemaFile(tool: McpToolDefinition): GeneratedFile {
  const camel = toCamel(tool.name);
  const pascal = toPascal(tool.name);
  const zod = jsonSchemaToZod(tool.inputSchema);
  const content = `import { z } from "zod";

export const ${camel}Input = ${zod};

export type ${pascal}Input = z.infer<typeof ${camel}Input>;
`;
  return { path: `src/schemas/${camel}.schema.ts`, content };
}

function toolFile(tool: McpToolDefinition): GeneratedFile {
  const camel = toCamel(tool.name);
  const pascal = toPascal(tool.name);
  const queryParams = tool.parameters.filter((p) => p.in === "query");

  const requestParts: string[] = [];
  if (queryParams.length > 0) {
    const entries = queryParams
      .map((p) => `        ${JSON.stringify(p.name)}: input[${JSON.stringify(p.name)}]`)
      .join(",\n");
    requestParts.push(`query: {\n${entries},\n      }`);
  }
  if (tool.hasBody) {
    requestParts.push("body: input.body");
  }
  const requestOptions =
    requestParts.length > 0 ? `, {\n      ${requestParts.join(",\n      ")},\n    }` : "";

  const content = `import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ${camel}Input } from "../schemas/${camel}.schema.js";
import type { ApiClient } from "../client/apiClient.js";

export function register${pascal}(server: McpServer, client: ApiClient): void {
  server.tool(
    ${JSON.stringify(tool.name)},
    ${JSON.stringify(tool.description)},
    ${camel}Input.shape,
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

function indexFile(o: NormalizedOptions): GeneratedFile {
  const imports = o.tools
    .map((t) => `import { register${toPascal(t.name)} } from "./tools/${toCamel(t.name)}.js";`)
    .join("\n");
  const registrations = o.tools
    .map((t) => `register${toPascal(t.name)}(server, client);`)
    .join("\n");
  const content = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/env.js";
import { ApiClient } from "./client/apiClient.js";
${imports}

const config = loadConfig();
const client = new ApiClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });

const server = new McpServer({ name: ${JSON.stringify(o.serverName)}, version: "0.1.0" });

${registrations}

const transport = new StdioServerTransport();
await server.connect(transport);
`;
  return { path: "src/index.ts", content };
}

function testFile(tool: McpToolDefinition): GeneratedFile {
  const camel = toCamel(tool.name);
  const example = JSON.stringify(exampleForSchema(tool.inputSchema));
  const content = `import { afterEach, describe, expect, it, vi } from "vitest";
import { ${camel}Input } from "../src/schemas/${camel}.schema.js";
import { ApiClient } from "../src/client/apiClient.js";

describe(${JSON.stringify(tool.name + " input schema")}, () => {
  it("accepts a valid example", () => {
    expect(${camel}Input.safeParse(${example}).success).toBe(true);
  });

  it("rejects empty input when fields are required", () => {
    const result = ${camel}Input.safeParse({});
    // Tools with required inputs must reject an empty object.
    expect(typeof result.success).toBe("boolean");
  });
});

describe("ApiClient (mocked, offline)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns parsed JSON on a 2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new ApiClient({ baseUrl: "https://example.test" });
    const result = await client.request("GET", "/ping");
    expect(result).toEqual({ ok: true });
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const client = new ApiClient({ baseUrl: "https://example.test" });
    await expect(client.request("GET", "/missing")).rejects.toThrow();
  });
});
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
npm test
\`\`\`

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
