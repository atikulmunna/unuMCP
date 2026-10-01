import type { AuthConfig, GenerateOptions, McpToolDefinition, RiskLevel } from "@unumcp/codegen";
import type { DetectedAuth, ExtractedEndpoint, JsonSchema } from "@unumcp/openapi";

/** An approved tool paired with the endpoint it was derived from. */
export interface ApprovedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  riskLevel: RiskLevel;
  endpoint: ExtractedEndpoint;
}

export interface BuildOptionsParams {
  serverName: string;
  displayName?: string;
  baseUrl: string;
  auth: DetectedAuth;
  tools: ApprovedTool[];
}

/**
 * Deterministically map approved tools + their endpoints into the codegen
 * input (P3-9). Pure: same inputs → same `GenerateOptions`, so generation is
 * reproducible (§9.7.0).
 */
export function buildGenerateOptions(params: BuildOptionsParams): GenerateOptions {
  const anyToolRequiresAuth = params.tools.some((t) => t.endpoint.authRequired);
  return {
    serverName: params.serverName,
    displayName: params.displayName,
    baseUrl: params.baseUrl,
    auth: toAuthConfig(params.auth, anyToolRequiresAuth),
    tools: params.tools.map(toToolDefinition),
  };
}

/** Path before query before header: on a name clash the earlier location owns the input. */
const LOCATION_ORDER = { path: 0, query: 1, header: 2 } as const;

function toToolDefinition(t: ApprovedTool): McpToolDefinition {
  const e = t.endpoint;
  // Bind exactly the inputs the approved schema exposes (proposal already left
  // out ignored and auth-managed headers), one binding per input name.
  const inputs = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const bound = new Set<string>();
  const parameters = e.parameters
    .filter((p): p is typeof p & { in: keyof typeof LOCATION_ORDER } => p.in in LOCATION_ORDER)
    .sort((a, b) => LOCATION_ORDER[a.in] - LOCATION_ORDER[b.in])
    .filter((p) => p.name in inputs && !bound.has(p.name) && bound.add(p.name))
    .map((p) => ({ name: p.name, in: p.in }));
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    method: e.method,
    pathTemplate: e.path,
    parameters,
    hasBody: e.requestSchema !== undefined,
    ...(e.requestMediaType && e.requestMediaType !== "application/json"
      ? { bodyMediaType: e.requestMediaType }
      : {}),
    authRequired: e.authRequired,
    riskLevel: t.riskLevel,
  };
}

/**
 * Pick a codegen auth strategy from detected schemes. Prefers a declared
 * apiKey-header or bearer scheme; when the spec gave us nothing usable but auth
 * is required (F-1), defaults to a bearer token the user wires up via `.env`.
 */
function toAuthConfig(auth: DetectedAuth, anyToolRequiresAuth: boolean): AuthConfig {
  if (!auth.required && !anyToolRequiresAuth) return { type: "none" };

  const apiKeyHeader = auth.schemes.find((s) => s.type === "apiKey" && s.in === "header");
  if (apiKeyHeader?.paramName) {
    return { type: "apiKeyHeader", envVar: "API_KEY", headerName: apiKeyHeader.paramName };
  }

  // bearer http scheme, or the F-1 assume-required fallback.
  return { type: "bearer", envVar: "API_TOKEN" };
}

/** Slugify a project name into a valid npm package name for the generated server. */
export function toServerName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "api"}-mcp-server`;
}
