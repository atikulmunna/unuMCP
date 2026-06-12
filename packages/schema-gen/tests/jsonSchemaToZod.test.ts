import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonSchema } from "@unumcp/openapi";
import { jsonSchemaToZod } from "../src/jsonSchemaToZod";

/** Evaluate a generated Zod source expression into a live schema. */
function build(expr: string): z.ZodTypeAny {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function("z", `return (${expr});`)(z) as z.ZodTypeAny;
}

function gen(schema: JsonSchema): string {
  return jsonSchemaToZod(schema);
}

describe("jsonSchemaToZod — primitives", () => {
  it("maps string/number/integer/boolean", () => {
    expect(gen({ type: "string" })).toBe("z.string()");
    expect(gen({ type: "number" })).toBe("z.number()");
    expect(gen({ type: "integer" })).toBe("z.number().int()");
    expect(gen({ type: "boolean" })).toBe("z.boolean()");
  });

  it("integer rejects floats at runtime", () => {
    const schema = build(gen({ type: "integer" }));
    expect(schema.safeParse(3).success).toBe(true);
    expect(schema.safeParse(3.5).success).toBe(false);
  });

  it("string enum → z.enum and validates members", () => {
    const src = gen({ type: "string", enum: ["a", "b"] } as JsonSchema);
    expect(src).toBe('z.enum(["a", "b"])');
    const schema = build(src);
    expect(schema.safeParse("a").success).toBe(true);
    expect(schema.safeParse("c").success).toBe(false);
  });

  it("numeric enum → union of literals", () => {
    const schema = build(gen({ type: "integer", enum: [1, 2] } as JsonSchema));
    expect(schema.safeParse(2).success).toBe(true);
    expect(schema.safeParse(3).success).toBe(false);
  });
});

describe("jsonSchemaToZod — objects", () => {
  const userSchema: JsonSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      age: { type: "integer" },
    },
    required: ["id"],
  } as JsonSchema;

  it("enforces required, allows optional missing", () => {
    const schema = build(gen(userSchema));
    expect(schema.safeParse({ id: "x" }).success).toBe(true);
    expect(schema.safeParse({ id: "x", age: 5 }).success).toBe(true);
    expect(schema.safeParse({ age: 5 }).success).toBe(false); // missing required id
  });

  it("nullable adds .nullable()", () => {
    const schema = build(gen({ type: "string", nullable: true } as JsonSchema));
    expect(schema.safeParse(null).success).toBe(true);
  });

  it("additionalProperties schema → z.record", () => {
    const schema = build(
      gen({ type: "object", additionalProperties: { type: "number" } } as JsonSchema),
    );
    expect(schema.safeParse({ a: 1, b: 2 }).success).toBe(true);
    expect(schema.safeParse({ a: "x" }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — composition (OD-1)", () => {
  it("allOf deep-merges object members", () => {
    const schema = build(
      gen({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
        ],
      } as JsonSchema),
    );
    expect(schema.safeParse({ a: "x", b: 1 }).success).toBe(true);
    expect(schema.safeParse({ a: "x" }).success).toBe(false); // b required via merge
  });

  it("oneOf without discriminator → z.union", () => {
    const src = gen({
      oneOf: [{ type: "string" }, { type: "number" }],
    } as JsonSchema);
    expect(src.startsWith("z.union(")).toBe(true);
    const schema = build(src);
    expect(schema.safeParse("x").success).toBe(true);
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(false);
  });

  it("oneOf with discriminator → z.discriminatedUnion", () => {
    const src = gen({
      oneOf: [
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["cat"] }, meow: { type: "boolean" } },
          required: ["kind"],
        },
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["dog"] }, bark: { type: "boolean" } },
          required: ["kind"],
        },
      ],
      discriminator: { propertyName: "kind" },
    } as JsonSchema);
    expect(src.startsWith("z.discriminatedUnion(")).toBe(true);
    const schema = build(src);
    expect(schema.safeParse({ kind: "cat", meow: true }).success).toBe(true);
    expect(schema.safeParse({ kind: "fish" }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — robustness", () => {
  it("unknown/typeless schema → z.unknown()", () => {
    expect(gen({} as JsonSchema)).toBe("z.unknown()");
  });

  it("handles circular schemas without infinite recursion", () => {
    const node: any = { type: "object", properties: { name: { type: "string" } } };
    node.properties.children = { type: "array", items: node };
    const src = gen(node);
    // Cycle point becomes a generic placeholder; generation terminates.
    expect(src.includes("z.unknown()")).toBe(true);
    expect(() => build(src)).not.toThrow();
  });

  it("is deterministic (byte-identical across runs) — OD-3", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object", properties: { n: { type: "integer" } } },
      },
      required: ["id"],
    } as JsonSchema;
    expect(gen(schema)).toBe(gen(schema));
  });
});
