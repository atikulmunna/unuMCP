import type { OpenAPIV3 } from "openapi-types";
import type { ExtractedEndpoint, JsonSchema, ParameterInfo } from "./types";

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/**
 * Extract raw endpoint metadata from a dereferenced OpenAPI document (FR-008).
 * Expects no remaining `$ref` (run {@link dereferenceSpec} first).
 */
export function extractEndpoints(doc: OpenAPIV3.Document): ExtractedEndpoint[] {
  const endpoints: ExtractedEndpoint[] = [];
  const globalSecurity = doc.security;
  const paths = doc.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;
    const sharedParams = (pathItem.parameters ?? []) as OpenAPIV3.ParameterObject[];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as OpenAPIV3.OperationObject | undefined;
      if (!op) continue;
      endpoints.push(buildEndpoint(path, method, op, sharedParams, globalSecurity));
    }
  }

  return endpoints;
}

function buildEndpoint(
  path: string,
  method: string,
  op: OpenAPIV3.OperationObject,
  sharedParams: OpenAPIV3.ParameterObject[],
  globalSecurity: OpenAPIV3.SecurityRequirementObject[] | undefined,
): ExtractedEndpoint {
  const opParams = (op.parameters ?? []) as OpenAPIV3.ParameterObject[];
  return {
    method,
    path,
    operationId: op.operationId,
    summary: op.summary,
    description: op.description,
    tags: op.tags ?? [],
    parameters: mergeParameters(sharedParams, opParams),
    requestSchema: pickRequestSchema(op),
    responseSchema: pickResponseSchema(op),
    authRequired: isAuthRequired(op, globalSecurity),
    deprecated: op.deprecated ?? false,
  };
}

/** Operation-level parameters override path-level ones with the same name+location. */
function mergeParameters(
  shared: OpenAPIV3.ParameterObject[],
  opParams: OpenAPIV3.ParameterObject[],
): ParameterInfo[] {
  const byKey = new Map<string, OpenAPIV3.ParameterObject>();
  for (const p of [...shared, ...opParams]) {
    byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()].map((p) => ({
    name: p.name,
    in: p.in as ParameterInfo["in"],
    required: p.required ?? p.in === "path",
    description: p.description,
    schema: p.schema as JsonSchema | undefined,
  }));
}

function pickRequestSchema(op: OpenAPIV3.OperationObject): JsonSchema | undefined {
  const body = op.requestBody as OpenAPIV3.RequestBodyObject | undefined;
  return body?.content?.["application/json"]?.schema as JsonSchema | undefined;
}

/** Picks the schema of the first 2xx response (falling back to `default`). */
function pickResponseSchema(op: OpenAPIV3.OperationObject): JsonSchema | undefined {
  const responses = op.responses ?? {};
  const successCode =
    Object.keys(responses).find((code) => code.startsWith("2")) ??
    (responses.default ? "default" : undefined);
  if (!successCode) return undefined;
  const resp = responses[successCode] as OpenAPIV3.ResponseObject | undefined;
  return resp?.content?.["application/json"]?.schema as JsonSchema | undefined;
}

/**
 * A request needs auth if the operation declares a non-empty security
 * requirement, or inherits a non-empty global one. An explicit empty array
 * (`security: []`) opts out, per the OpenAPI spec.
 */
function isAuthRequired(
  op: OpenAPIV3.OperationObject,
  globalSecurity: OpenAPIV3.SecurityRequirementObject[] | undefined,
): boolean {
  const effective = op.security ?? globalSecurity;
  return Array.isArray(effective) && effective.length > 0;
}
