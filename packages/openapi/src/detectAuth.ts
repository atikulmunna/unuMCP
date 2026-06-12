import type { OpenAPIV3 } from "openapi-types";

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

/** A single security scheme declared in `components.securitySchemes`. */
export interface DetectedAuthScheme {
  /** The key under `securitySchemes` (e.g. "bearerAuth"). */
  id: string;
  type: "http" | "apiKey" | "oauth2" | "openIdConnect";
  /** For `http`: the HTTP auth scheme, e.g. "bearer" | "basic". */
  httpScheme?: string;
  /** For `apiKey`: where the key is sent. */
  in?: "header" | "query" | "cookie";
  /** For `apiKey`: the header/query/cookie parameter name. */
  paramName?: string;
}

/** Result of inspecting a spec's auth (FR-016, FR-017). */
export interface DetectedAuth {
  /** Whether auth appears required — either declared, or assumed via the F-1 fallback. */
  required: boolean;
  /** True when no machine-readable scheme existed and we assumed auth is required (F-1). */
  assumed: boolean;
  /** True when the user must configure auth manually because the spec gives us nothing usable. */
  needsUserConfig: boolean;
  /** Declared schemes (empty for GitHub-style specs that encode auth out-of-band). */
  schemes: DetectedAuthScheme[];
}

/**
 * Detect authentication from an OpenAPI document.
 *
 * When `components.securitySchemes` is absent or empty we cannot auto-configure
 * auth (the GitHub spec encodes it in a vendor extension — finding F-1). In that
 * case we default to *assume required + prompt the user* rather than silently
 * emitting an unauthenticated client.
 */
export function detectAuth(doc: OpenAPIV3.Document): DetectedAuth {
  const schemes = collectSchemes(doc.components?.securitySchemes);

  if (schemes.length === 0) {
    return { required: true, assumed: true, needsUserConfig: true, schemes: [] };
  }

  return {
    required: anyOperationRequiresAuth(doc),
    assumed: false,
    needsUserConfig: false,
    schemes,
  };
}

function collectSchemes(
  raw: OpenAPIV3.ComponentsObject["securitySchemes"] | undefined,
): DetectedAuthScheme[] {
  if (!raw) return [];
  const out: DetectedAuthScheme[] = [];
  for (const [id, value] of Object.entries(raw)) {
    // After dereferencing these are SecuritySchemeObjects, not $refs.
    const scheme = value as OpenAPIV3.SecuritySchemeObject;
    if (!scheme || typeof scheme !== "object" || !("type" in scheme)) continue;
    switch (scheme.type) {
      case "http":
        out.push({ id, type: "http", httpScheme: scheme.scheme });
        break;
      case "apiKey":
        out.push({
          id,
          type: "apiKey",
          in: scheme.in as DetectedAuthScheme["in"],
          paramName: scheme.name,
        });
        break;
      case "oauth2":
        out.push({ id, type: "oauth2" });
        break;
      case "openIdConnect":
        out.push({ id, type: "openIdConnect" });
        break;
    }
  }
  return out;
}

/**
 * True if any operation requires auth. A non-empty global `security` applies to
 * every operation that doesn't override it, so it alone makes the answer `true`.
 * An operation-level `security: []` opts that operation out (OpenAPI semantics).
 */
function anyOperationRequiresAuth(doc: OpenAPIV3.Document): boolean {
  if (Array.isArray(doc.security) && doc.security.length > 0) return true;

  for (const pathItem of Object.values(doc.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as OpenAPIV3.OperationObject | undefined;
      if (op?.security && op.security.length > 0) return true;
    }
  }
  return false;
}
