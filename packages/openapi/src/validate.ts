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
    // not JSON; try YAML next
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
  } else if (doc.openapi === undefined) {
    // Swagger 2.0 keeps bodies in `in: body` parameters and the server in
    // `host`/`basePath`; read as OpenAPI 3 those would silently vanish.
    errors.push(
      `Swagger ${openapiVersion} specs aren't supported yet. Convert it to OpenAPI 3 first (for example with the swagger2openapi CLI or the Swagger Editor's "Convert to OpenAPI 3"), then upload the result.`,
    );
  }

  const paths = doc.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== "object") {
    errors.push("Missing or invalid `paths` section.");
  } else if (Object.keys(paths).length === 0) {
    errors.push("The `paths` section contains no API paths.");
  }

  const external = externalRefs(doc);
  if (external.length > 0) {
    const shown = external.slice(0, 3).map((ref) => `"${ref}"`).join(", ");
    const more = external.length > 3 ? ` and ${external.length - 3} more` : "";
    errors.push(
      `References to other files or URLs aren't supported (${shown}${more}). Bundle the spec into a single file (for example with \`redocly bundle\`), then upload the result.`,
    );
  }

  const info = doc.info as Record<string, unknown> | undefined;
  const baseUrl = Array.isArray(doc.servers) ? (doc.servers[0] as { url?: unknown } | undefined)?.url : undefined;
  // The base URL is written into the generated server's .env.example and README,
  // so a line break in it would add lines of the spec author's choosing there.
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || /[\s\p{Cc}]/u.test(baseUrl))) {
    errors.push("The first server URL must be a single URL, with no spaces or line breaks.");
  }

  return {
    valid: errors.length === 0,
    errors,
    openapiVersion,
    title: info?.title as string | undefined,
    version: info?.version as string | undefined,
    baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
  };
}

/**
 * Every `$ref` that points outside the document (a file path or URL), in
 * document order without repeats. Resolving one would make the server read its
 * own files or fetch URLs for whoever uploaded the spec. YAML aliases can make
 * the parsed object graph cyclic, so the walk is cycle-guarded.
 */
function externalRefs(doc: unknown): string[] {
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const ref = (node as Record<string, unknown>).$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) found.add(ref);
    for (const value of Object.values(node)) walk(value);
  };
  walk(doc);
  return [...found];
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
