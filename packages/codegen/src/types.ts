import type { JsonSchema } from "@unumcp/openapi";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolParameterBinding {
  name: string;
  in: "path" | "query" | "header";
}

/**
 * Everything codegen needs to deterministically generate one MCP tool.
 * Produced by the tool-design stage (LLM names/descriptions + deterministic
 * input schema); for the Phase 0 spike a definition is hand-authored.
 */
export interface McpToolDefinition {
  /** snake_case tool name (FR-012). */
  name: string;
  description: string;
  /** Assembled object schema: path/query params as properties + optional `body`. */
  inputSchema: JsonSchema;
  /** HTTP binding. */
  method: string;
  pathTemplate: string;
  parameters: ToolParameterBinding[];
  hasBody: boolean;
  authRequired: boolean;
  riskLevel: RiskLevel;
}

export type AuthConfig =
  | { type: "none" }
  | { type: "bearer"; envVar: string }
  | { type: "apiKeyHeader"; envVar: string; headerName: string };

export interface GenerateOptions {
  /** npm package name, e.g. "github-mcp-server". */
  serverName: string;
  displayName?: string;
  baseUrl: string;
  baseUrlEnvVar?: string;
  tools: McpToolDefinition[];
  auth: AuthConfig;
  mcpSdkVersion?: string;
  zodVersion?: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}
