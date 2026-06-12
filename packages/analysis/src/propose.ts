import type { ExtractedEndpoint, JsonSchema } from "@unumcp/openapi";
import type { OperationType, ToolDraft } from "./types";
import { classifyEndpoint, scoreRisk } from "./classify";
import { generateToolName, uniqueName } from "./naming";

const MUTATING: OperationType[] = ["create", "update", "delete", "upload"];

/** Assemble a tool-input JSON Schema from an endpoint's params + request body. */
export function assembleToolInput(e: ExtractedEndpoint): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const p of e.parameters) {
    if (p.in !== "path" && p.in !== "query") continue;
    properties[p.name] = (p.schema ?? { type: "string" }) as JsonSchema;
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
  return MUTATING.includes(operationType) ? `${base} (modifies data).` : base;
}

/**
 * Deterministically propose one MCP tool per endpoint (1:1 default, §9.5.0).
 * Names/descriptions are rule-based fallbacks the LLM stage can refine.
 */
export function proposeTools(endpoints: ExtractedEndpoint[]): ToolDraft[] {
  const used = new Set<string>();
  return endpoints.map((e) => {
    const operationType = classifyEndpoint(e);
    const riskLevel = scoreRisk(e, operationType);
    return {
      name: uniqueName(generateToolName(e, operationType), used),
      description: fallbackDescription(e, operationType),
      inputSchema: assembleToolInput(e),
      operationType,
      riskLevel,
      authRequired: e.authRequired,
      method: e.method,
      path: e.path,
      operationId: e.operationId,
      enabledByDefault: riskLevel !== "high" && riskLevel !== "critical",
    };
  });
}
