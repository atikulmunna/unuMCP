import type { OpenAPIV3 } from "openapi-types";

/** A resolved (no `$ref`) JSON Schema as it appears in an OpenAPI document. */
export type JsonSchema = OpenAPIV3.SchemaObject;

export interface ParameterInfo {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema?: JsonSchema;
}

/**
 * Raw endpoint metadata extracted from an OpenAPI document (FR-008).
 * Classification, risk, and tool mapping are added by later stages.
 */
export interface ExtractedEndpoint {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: ParameterInfo[];
  requestSchema?: JsonSchema;
  responseSchema?: JsonSchema;
  authRequired: boolean;
  deprecated: boolean;
}
