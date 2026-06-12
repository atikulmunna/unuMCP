import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";

/**
 * Resolve all `$ref` pointers in an OpenAPI document (OD-1, SRS §9.5.0).
 *
 * Circular references are preserved as in-memory object cycles rather than
 * being expanded infinitely, so no unresolved `$ref` remains but any traversal
 * of the result must be cycle-guarded (see schema-gen's depth cap).
 *
 * The input is cloned first because SwaggerParser mutates the document it is
 * given; callers keep their original object intact.
 */
export async function dereferenceSpec(input: object): Promise<OpenAPIV3.Document> {
  const clone = structuredClone(input);
  const api = await SwaggerParser.dereference(clone as never);
  return api as OpenAPIV3.Document;
}

/**
 * Returns true if any `$ref` key remains anywhere in the object graph.
 * Cycle-guarded so circular (already-resolved) references do not loop forever.
 */
export function hasUnresolvedRef(root: unknown): boolean {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (!Array.isArray(node) && "$ref" in (node as Record<string, unknown>)) {
      return true;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (walk(value)) return true;
    }
    return false;
  };
  return walk(root);
}
