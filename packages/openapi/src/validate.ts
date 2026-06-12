import YAML from "yaml";

export interface ParseResult {
  ok: boolean;
  doc?: Record<string, unknown>;
  error?: string;
}

/** Parse a raw spec string as JSON, falling back to YAML (FR-006/007). */
export function parseSpec(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Spec is empty." };

  try {
    const doc = JSON.parse(trimmed);
    if (doc && typeof doc === "object") return { ok: true, doc };
  } catch {
    // not JSON — try YAML next
  }

  try {
    const doc = YAML.parse(trimmed);
    if (doc && typeof doc === "object") {
      return { ok: true, doc: doc as Record<string, unknown> };
    }
    return { ok: false, error: "Spec is not a JSON or YAML object." };
  } catch {
    return { ok: false, error: "Could not parse spec as JSON or YAML." };
  }
}

export interface SpecValidation {
  valid: boolean;
  errors: string[];
  openapiVersion?: string;
  title?: string;
  version?: string;
  baseUrl?: string;
}

/** Structural OpenAPI validation with user-friendly messages (FR-007). */
export function validateSpec(doc: Record<string, unknown>): SpecValidation {
  const errors: string[] = [];

  const openapiVersion = (doc.openapi ?? doc.swagger) as string | undefined;
  if (!openapiVersion) {
    errors.push("Missing `openapi` (or `swagger`) version field.");
  }

  const paths = doc.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== "object") {
    errors.push("Missing or invalid `paths` section.");
  } else if (Object.keys(paths).length === 0) {
    errors.push("The `paths` section contains no API paths.");
  }

  const info = doc.info as Record<string, unknown> | undefined;
  const servers = doc.servers as Array<{ url?: string }> | undefined;

  return {
    valid: errors.length === 0,
    errors,
    openapiVersion,
    title: info?.title as string | undefined,
    version: info?.version as string | undefined,
    baseUrl: servers?.[0]?.url,
  };
}

/**
 * Deep-clone a value, replacing circular references with `{ $circular: true }`.
 * Dereferenced OpenAPI schemas can be self-referential (e.g. GitHub), which
 * makes them unsafe to `JSON.stringify` / persist as-is.
 */
export function toCycleSafe<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return { $circular: true };
    seen.add(v as object);
    const result: Record<string, unknown> | unknown[] = Array.isArray(v) ? [] : {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      (result as Record<string, unknown>)[k] = walk(val);
    }
    seen.delete(v as object);
    return result;
  };
  return walk(value) as T;
}
