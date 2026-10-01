import type { ExtractedEndpoint } from "@unumcp/openapi";
import type { OperationType } from "./types";

const VERB: Record<OperationType, string> = {
  read: "get",
  search: "list",
  create: "create",
  update: "update",
  delete: "delete",
  upload: "upload",
  download: "download",
  admin: "admin",
  auth: "auth",
  unknown: "call",
};

/** Common MCP clients reject tool names longer than 64 characters. */
export const MAX_TOOL_NAME_LENGTH = 64;

function snake(input: string): string {
  return input
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2") // acronym boundary: HTTPResponse → HTTP_Response
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/** Clamp to the client length limit, never ending on an underscore. */
function clamp(name: string, max = MAX_TOOL_NAME_LENGTH): string {
  return name.length <= max ? name : name.slice(0, max).replace(/_+$/, "");
}

/** Verb-first fallback from method + path + op type, for endpoints without an operationId. */
function nameFromPath(e: ExtractedEndpoint, operationType: OperationType): string {
  const verb = VERB[operationType] ?? "call";
  const segments = e.path.split("/").filter((s) => s && !s.startsWith("{"));
  const resource = segments.length > 0 ? segments[segments.length - 1]! : "resource";
  const lastIsParam = e.path.split("/").pop()?.startsWith("{") ?? false;
  const suffix = lastIsParam && operationType === "read" ? "_by_id" : "";
  return snake(`${verb}_${resource}${suffix}`);
}

/**
 * Deterministic snake_case tool name (FR-012). Prefers the spec's `operationId`
 * (GitHub's `pulls/merge` → `pulls_merge`, Petstore's `getPetById` →
 * `get_pet_by_id`): it is the name the API's own docs use, and it tells apart
 * actions a method + path can't (merge vs update). Falls back to a verb-first
 * name from method + path. Always a letter first, at most 64 characters.
 */
export function generateToolName(e: ExtractedEndpoint, operationType: OperationType): string {
  let name = (e.operationId ? snake(e.operationId) : "") || nameFromPath(e, operationType);
  if (!/^[a-z]/.test(name)) name = `op_${name}`;
  return clamp(name);
}

/**
 * Ensures a name is unique within a set, disambiguating with a numeric suffix
 * while staying within the length limit.
 */
export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let i = 2;
  const candidate = (n: number) => `${clamp(name, MAX_TOOL_NAME_LENGTH - `_${n}`.length)}_${n}`;
  while (used.has(candidate(i))) i++;
  const result = candidate(i);
  used.add(result);
  return result;
}
