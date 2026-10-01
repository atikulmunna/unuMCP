import { exampleForSchema } from "./helpers";
import type { AuthConfig, McpToolDefinition } from "./types";

/** The API key the generated tests configure; auth expectations are derived from it. */
export const TEST_API_KEY = "test-api-key";

const FORM_TYPE = "application/x-www-form-urlencoded";

/**
 * One contract case for a tool: arguments to call it with, and the HTTP
 * request the API spec says those arguments must produce. The expectation is
 * derived from the tool's definition (path template, parameter locations,
 * media type, auth) by rules independent of the generated handler, so a
 * handler that maps an input to the wrong place fails its test.
 */
export interface ContractCase {
  args: Record<string, unknown>;
  request: {
    method: string;
    /** The path template filled with the arguments, percent-encoded. */
    path: string;
    /** Query pairs in order, serialized per OpenAPI's default (form, explode). */
    query: Array<[string, string]>;
    /** Headers that must be present (lowercased names): header inputs and auth. */
    headers: Record<string, string>;
    body?: { contentType: string; json?: unknown; form?: Array<[string, string]> };
  };
}

/**
 * An example value for a schema, with every array given two items: one item
 * can't tell "repeat the key" (?tag=a&tag=a) from "join the values" (?tag=a,a),
 * so a single-item example would let that serialization bug pass.
 */
function contractExample(schema: unknown): unknown {
  const twoItems = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.length > 0 ? [twoItems(value[0]), twoItems(value[0])] : value;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, twoItems(item)]));
    }
    return value;
  };
  return twoItems(exampleForSchema(schema));
}

export function contractCase(tool: McpToolDefinition, auth: AuthConfig): ContractCase {
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const args: Record<string, unknown> = {};
  for (const p of tool.parameters) {
    const value = contractExample(properties[p.name]);
    args[p.name] = value ?? "example";
  }
  if (tool.hasBody && "body" in properties) args.body = contractExample(properties.body);

  const path = tool.pathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(String(args[name])),
  );

  const query: Array<[string, string]> = [];
  for (const p of tool.parameters.filter((b) => b.in === "query")) {
    appendQuery(query, p.name, args[p.name]);
  }

  const headers: Record<string, string> = {};
  for (const p of tool.parameters.filter((b) => b.in === "header")) {
    const value = args[p.name];
    if (value !== undefined && value !== null) headers[p.name.toLowerCase()] = String(value);
  }
  if (auth.type === "bearer") headers["authorization"] = `Bearer ${TEST_API_KEY}`;
  if (auth.type === "apiKeyHeader") headers[auth.headerName.toLowerCase()] = TEST_API_KEY;

  let body: ContractCase["request"]["body"];
  if (tool.hasBody && args.body !== undefined) {
    const contentType = tool.bodyMediaType ?? "application/json";
    body = contentType === FORM_TYPE ? { contentType, form: formPairs(args.body) } : { contentType, json: args.body };
  }

  return { args, request: { method: tool.method.toUpperCase(), path, query, headers, ...(body ? { body } : {}) } };
}

/** OpenAPI's default query style (form, explode): repeated keys for arrays, one pair per property for objects. */
function appendQuery(out: Array<[string, string]>, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) if (item !== undefined && item !== null) out.push([key, String(item)]);
  } else if (typeof value === "object") {
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined && item !== null) out.push([name, String(item)]);
    }
  } else {
    out.push([key, String(value)]);
  }
}

/** Form fields with bracket nesting (a[b]=1, list[0]=x), as decoded pairs. */
function formPairs(value: unknown, prefix = ""): Array<[string, string]> {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => formPairs(item, `${prefix}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([name, item]) =>
      formPairs(item, prefix ? `${prefix}[${name}]` : name),
    );
  }
  return [[prefix, String(value)]];
}
