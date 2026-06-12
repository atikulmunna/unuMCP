import type { JsonSchema } from "@unumcp/openapi";

export type OperationType =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "search"
  | "admin"
  | "auth"
  | "upload"
  | "download"
  | "unknown";

export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * A deterministically-proposed MCP tool. Names and descriptions here are
 * rule-based fallbacks; the LLM stage later refines them (§9.7.0). Input
 * schema, mapping, classification, and risk are fully deterministic.
 */
export interface ToolDraft {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  operationType: OperationType;
  riskLevel: RiskLevel;
  authRequired: boolean;
  method: string;
  path: string;
  operationId?: string;
  /** High/critical risk tools are disabled by default (FR-010, FR-015). */
  enabledByDefault: boolean;
}
