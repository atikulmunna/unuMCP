import type { JsonSchema } from "@unumcp/openapi";

export interface ZodGenOptions {
  /** Append `.describe(...)` from schema descriptions. Default true. */
  includeDescriptions?: boolean;
  /** Safety bound on nesting depth (beyond it → generic fallback). Default 50. */
  maxDepth?: number;
}

const DEFAULTS: Required<ZodGenOptions> = {
  includeDescriptions: true,
  maxDepth: 50,
};

/**
 * Internal, standalone schema view. Deliberately not an intersection with the
 * openapi-types `SchemaObject` (which carries a `ReferenceObject` union that
 * pollutes recursion). Inputs are dereferenced, so the boundary cast is safe.
 */
interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  enum?: unknown[];
  nullable?: boolean;
  description?: string;
  additionalProperties?: boolean | Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  discriminator?: { propertyName: string };
}

/**
 * Deterministically convert a (dereferenced) JSON Schema into a Zod source
 * expression string (FR-020, §9.7.0). Pure: same input → byte-identical output.
 *
 * Composition handling (OD-1, §9.5.0):
 *  - `allOf`  → deep-merge object members into one `z.object`; non-object members fall back to `z.intersection`.
 *  - `oneOf`  → `z.discriminatedUnion` when a discriminator is present, else `z.union`.
 *  - `anyOf`  → `z.union`.
 *  - cycles   → generic `z.unknown()` placeholder (ancestor-tracked, so legitimate deep nesting is not truncated).
 */
export function jsonSchemaToZod(schema: JsonSchema, options: ZodGenOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  return convert(schema as unknown as Schema, opts, new Set<object>(), 0);
}

function convert(
  schema: Schema | undefined | null,
  opts: Required<ZodGenOptions>,
  ancestors: Set<object>,
  depth: number,
): string {
  if (!schema || typeof schema !== "object") return "z.unknown()";
  if (ancestors.has(schema) || depth > opts.maxDepth) return "z.unknown()";

  ancestors.add(schema);
  try {
    let base: string;
    if (schema.allOf?.length) {
      base = convertAllOf(schema, opts, ancestors, depth);
    } else if (schema.oneOf?.length || schema.anyOf?.length) {
      base = convertUnion(schema, opts, ancestors, depth);
    } else if (schema.enum?.length) {
      base = convertEnum(schema);
    } else {
      base = convertByType(schema, opts, ancestors, depth);
    }
    return applyModifiers(base, schema, opts);
  } finally {
    ancestors.delete(schema);
  }
}

function convertByType(
  schema: Schema,
  opts: Required<ZodGenOptions>,
  ancestors: Set<object>,
  depth: number,
): string {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string":
      return "z.string()";
    case "integer":
      return "z.number().int()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    case "array":
      return convertArray(schema, opts, ancestors, depth);
    case "object":
      return convertObject(schema, opts, ancestors, depth);
    default:
      // No explicit type: infer object when properties exist, else generic.
      if (schema.properties || schema.additionalProperties) {
        return convertObject(schema, opts, ancestors, depth);
      }
      return "z.unknown()";
  }
}

function convertObject(
  schema: Schema,
  opts: Required<ZodGenOptions>,
  ancestors: Set<object>,
  depth: number,
): string {
  const props = schema.properties ?? {};
  const entries = Object.entries(props);
  const required = new Set(schema.required ?? []);

  if (entries.length === 0) {
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const value = convert(schema.additionalProperties, opts, ancestors, depth + 1);
      return `z.record(z.string(), ${value})`;
    }
    if (schema.additionalProperties === true) {
      return "z.record(z.string(), z.unknown())";
    }
    return "z.object({})";
  }

  const lines = entries.map(([key, sub]) => {
    let value = convert(sub, opts, ancestors, depth + 1);
    if (!required.has(key)) value += ".optional()";
    return `  ${JSON.stringify(key)}: ${value}`;
  });

  let out = `z.object({\n${lines.join(",\n")}\n})`;
  if (schema.additionalProperties === true) out += ".passthrough()";
  return out;
}

function convertArray(
  schema: Schema,
  opts: Required<ZodGenOptions>,
  ancestors: Set<object>,
  depth: number,
): string {
  const items = convert(schema.items, opts, ancestors, depth + 1);
  return `z.array(${items})`;
}

function convertEnum(schema: Schema): string {
  const values = schema.enum ?? [];
  const isStringType =
    schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"));
  if (isStringType && values.every((v) => typeof v === "string")) {
    return `z.enum([${values.map((v) => JSON.stringify(v)).join(", ")}])`;
  }
  const literals = values.map((v) => (v === null ? "z.null()" : `z.literal(${JSON.stringify(v)})`));
  if (literals.length === 1) return literals[0]!;
  return `z.union([${literals.join(", ")}])`;
}

function convertAllOf(
  schema: Schema,
  opts: Required<ZodGenOptions>,
  ancestors: Set<object>,
  depth: number,
): string {
  const members = schema.allOf ?? [];
  const allObjects = members.every(
    (m) => m && typeof m === "object" && (m.type === "object" || m.properties),
  );

  if (allObjects) {
    const mergedProps: Record<string, Schema> = {};
    const required = new Set<string>();
    for (const m of members) {
      Object.assign(mergedProps, m.properties ?? {});
      for (const r of m.required ?? []) required.add(r);
    }
    const merged: Schema = {
      type: "object",
      properties: mergedProps,
      required: [...required],
    };
    return convertObject(merged, opts, ancestors, depth);
  }

  const parts = members.map((m) => convert(m, opts, ancestors, depth + 1));
  return parts.reduce((a, b) => `z.intersection(${a}, ${b})`);
}

function convertUnion(
  schema: Schema,
  opts: Required<ZodGenOptions>,
  ancestors: Set<object>,
  depth: number,
): string {
  const variants = schema.oneOf ?? schema.anyOf ?? [];
  const parts = variants.map((v) => convert(v, opts, ancestors, depth + 1));
  if (parts.length === 0) return "z.unknown()";
  if (parts.length === 1) return parts[0]!;
  if (schema.oneOf?.length && schema.discriminator?.propertyName) {
    return `z.discriminatedUnion(${JSON.stringify(
      schema.discriminator.propertyName,
    )}, [${parts.join(", ")}])`;
  }
  return `z.union([${parts.join(", ")}])`;
}

function applyModifiers(base: string, schema: Schema, opts: Required<ZodGenOptions>): string {
  let out = base;
  if (schema.nullable) out += ".nullable()";
  if (opts.includeDescriptions && schema.description) {
    out += `.describe(${JSON.stringify(schema.description)})`;
  }
  return out;
}
