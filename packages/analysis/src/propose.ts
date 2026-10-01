import type { ExtractedEndpoint, JsonSchema, ParameterInfo } from "@unumcp/openapi";
import type { OperationType, ToolDraft } from "./types";
import { classifyEndpoint, scoreRisk } from "./classify";
import { generateToolName, uniqueName } from "./naming";

const MUTATING: OperationType[] = ["create", "update", "delete", "upload"];

/** Header parameters OpenAPI says to ignore: auth and content negotiation set them. */
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"]);

/** Path and query first, so a same-named header can never shadow them. */
const LOCATION_ORDER: Record<ParameterInfo["in"], number> = { path: 0, query: 1, header: 2, cookie: 3 };

export interface ToolInputOptions {
  /**
   * Headers the generated server's auth already sends (e.g. an API-key header
   * scheme), which must not become tool inputs the agent has to supply.
   */
  authHeaders?: readonly string[];
}

/**
 * Assemble a tool-input JSON Schema from an endpoint's path, query, and header
 * parameters plus its request body. A parameter's own `description` (where
 * OpenAPI usually documents it) is carried onto its schema, since the schema is
 * all the agent sees.
 */
export function assembleToolInput(e: ExtractedEndpoint, options: ToolInputOptions = {}): JsonSchema {
  const authHeaders = new Set((options.authHeaders ?? []).map((h) => h.toLowerCase()));
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const params = [...e.parameters].sort((a, b) => LOCATION_ORDER[a.in] - LOCATION_ORDER[b.in]);
  for (const p of params) {
    if (p.in === "cookie") continue;
    if (p.in === "header" && (IGNORED_HEADERS.has(p.name.toLowerCase()) || authHeaders.has(p.name.toLowerCase()))) {
      continue;
    }
    if (p.name in properties) continue;
    const schema = (p.schema ?? { type: "string" }) as JsonSchema;
    properties[p.name] = p.description && !schema.description ? { ...schema, description: p.description } : schema;
    if (p.required) required.push(p.name);
  }
  if (e.requestSchema) {
    properties["body"] = e.requestSchema;
    required.push("body");
  }
  return { type: "object", properties, required } as JsonSchema;
}

function fallbackDescription(e: ExtractedEndpoint, operationType: OperationType): string {
  const base = e.summary?.trim() || `${e.method.toUpperCase()} ${e.path}`;
  let text = MUTATING.includes(operationType) ? `${base} (modifies data).` : base;
  if (e.deprecated) text += " Deprecated: the API may remove this endpoint.";
  if (e.unsupportedRequestBody) {
    text += ` Its request body (${e.unsupportedRequestBody}) isn't supported, so this tool sends none.`;
  }
  return text;
}

/**
 * Deterministically propose one MCP tool per endpoint (1:1 default, §9.5.0).
 * Names/descriptions are rule-based fallbacks the LLM stage can refine. High
 * and critical risk tools, deprecated endpoints, and endpoints whose request
 * body the generated client can't send start disabled: the user can still
 * enable them at approval.
 */
export function proposeTools(endpoints: ExtractedEndpoint[], options: ToolInputOptions = {}): ToolDraft[] {
  const used = new Set<string>();
  return endpoints.map((e) => {
    const operationType = classifyEndpoint(e);
    const riskLevel = scoreRisk(e, operationType);
    return {
      name: uniqueName(generateToolName(e, operationType), used),
      description: fallbackDescription(e, operationType),
      inputSchema: assembleToolInput(e, options),
      operationType,
      riskLevel,
      authRequired: e.authRequired,
      method: e.method,
      path: e.path,
      operationId: e.operationId,
      enabledByDefault:
        riskLevel !== "high" && riskLevel !== "critical" && !e.deprecated && !e.unsupportedRequestBody,
    };
  });
}
