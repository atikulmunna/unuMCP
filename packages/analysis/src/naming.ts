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

function snake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/**
 * Deterministic snake_case, verb-first tool name from method + path + op type
 * (FR-012). The LLM may later improve this; rules guarantee a valid fallback.
 */
export function generateToolName(e: ExtractedEndpoint, operationType: OperationType): string {
  const verb = VERB[operationType] ?? "call";
  const segments = e.path.split("/").filter((s) => s && !s.startsWith("{"));
  const resource = segments.length > 0 ? segments[segments.length - 1]! : "resource";
  const lastIsParam = e.path.split("/").pop()?.startsWith("{") ?? false;
  const suffix = lastIsParam && operationType === "read" ? "_by_id" : "";
  return snake(`${verb}_${resource}${suffix}`);
}

/** Ensures a name is unique within a set, disambiguating with a numeric suffix. */
export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let i = 2;
  while (used.has(`${name}_${i}`)) i++;
  const result = `${name}_${i}`;
  used.add(result);
  return result;
}
