/** snake_case or kebab → camelCase. */
export function toCamel(name: string): string {
  return name.replace(/[_-]([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

/** camelCase → PascalCase. */
export function toPascal(name: string): string {
  const camel = toCamel(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Build a JS expression (string) that reconstructs a path template at runtime,
 * substituting `{param}` segments with `encodeURIComponent(String(input.param))`.
 * Uses string concatenation (no backticks) to keep generated output simple.
 */
export function pathExpression(pathTemplate: string): string {
  const parts: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(pathTemplate)) !== null) {
    const literal = pathTemplate.slice(lastIndex, m.index);
    if (literal) parts.push(JSON.stringify(literal));
    parts.push(`encodeURIComponent(String(input[${JSON.stringify(m[1])}]))`);
    lastIndex = regex.lastIndex;
  }
  const tail = pathTemplate.slice(lastIndex);
  if (tail) parts.push(JSON.stringify(tail));
  return parts.length > 0 ? parts.join(" + ") : JSON.stringify(pathTemplate);
}

/** Standalone schema view (avoids the openapi-types ReferenceObject union). */
interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  enum?: unknown[];
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
}

/**
 * Produce a minimal value that satisfies the schema, for use as a positive
 * test fixture. Deterministic; favors required fields.
 */
export function exampleForSchema(schema: unknown, depth = 0): unknown {
  const s = schema as Schema | undefined;
  if (!s || depth > 6) return null;

  if (s.allOf?.length) {
    return s.allOf.reduce<Record<string, unknown>>((acc, member) => {
      const part = exampleForSchema(member, depth + 1);
      return part && typeof part === "object" ? { ...acc, ...part } : acc;
    }, {});
  }
  if (s.oneOf?.length || s.anyOf?.length) {
    return exampleForSchema((s.oneOf ?? s.anyOf)![0], depth + 1);
  }
  if (s.enum?.length) return s.enum[0];

  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "string":
      return "example";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array":
      return s.items ? [exampleForSchema(s.items, depth + 1)] : [];
    case "object":
      return exampleObject(s, depth);
    default:
      return s.properties ? exampleObject(s, depth) : "example";
  }
}

function exampleObject(s: Schema, depth: number): Record<string, unknown> {
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  const keys = Object.keys(props);
  const chosen = required.size > 0 ? keys.filter((k) => required.has(k)) : keys;
  const out: Record<string, unknown> = {};
  for (const key of chosen) {
    out[key] = exampleForSchema(props[key], depth + 1);
  }
  return out;
}
