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
  /** Schema of the request body, when it uses a media type the generated client can send. */
  requestSchema?: JsonSchema;
  /** That body's media type: `application/json`, a `+json` type, or form-urlencoded. */
  requestMediaType?: string;
  /**
   * Set when the operation takes a body but only in media types the generated
   * client can't send (multipart, binary, XML...): the declared types, joined.
   */
  unsupportedRequestBody?: string;
  responseSchema?: JsonSchema;
  authRequired: boolean;
  deprecated: boolean;
}
