/**
 * Phase 0 / P0-3 validation: deterministically build a Zod input schema from a
 * real GitHub endpoint (parameters + request body) and prove byte-identical
 * output across two runs (OD-3 determinism).
 *
 * Run: pnpm tsx spikes/zodgen-github.ts
 */
import { readFileSync } from "node:fs";
import { dereferenceSpec, extractEndpoints, type ExtractedEndpoint } from "@unumcp/openapi";
import { jsonSchemaToZod } from "@unumcp/schema-gen";
import type { JsonSchema } from "@unumcp/openapi";

/** Assemble a single tool-input JSON Schema from an endpoint's params + body. */
function endpointInputSchema(ep: ExtractedEndpoint): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const p of ep.parameters) {
    properties[p.name] = (p.schema ?? { type: "string" }) as JsonSchema;
    if (p.required) required.push(p.name);
  }
  if (ep.requestSchema) {
    properties["body"] = ep.requestSchema;
    required.push("body");
  }

  return { type: "object", properties, required } as JsonSchema;
}

async function main(): Promise<void> {
  const spec = JSON.parse(
    readFileSync(new URL("./specs/github.json", import.meta.url), "utf8"),
  );
  const deref = await dereferenceSpec(spec);
  const endpoints = extractEndpoints(deref);

  // A meaty real endpoint: create an issue (path params + request body).
  const target =
    endpoints.find((e) => e.operationId === "issues/create") ??
    endpoints.find((e) => e.requestSchema && e.parameters.length > 0)!;

  console.log(`endpoint: ${target.method.toUpperCase()} ${target.path} (${target.operationId})`);
  console.log(`params: ${target.parameters.length} | hasBody: ${Boolean(target.requestSchema)}`);

  const inputSchema = endpointInputSchema(target);
  const run1 = jsonSchemaToZod(inputSchema);
  const run2 = jsonSchemaToZod(inputSchema);

  console.log("\n--- generated Zod (truncated) ---");
  console.log(run1.length > 1200 ? run1.slice(0, 1200) + "\n…(truncated)" : run1);

  console.log(`\nbyte-identical across runs: ${run1 === run2}`);
  if (run1 !== run2) {
    console.error("FAIL: non-deterministic output");
    process.exit(1);
  }
  console.log("OK: OD-3 determinism holds on a real GitHub endpoint");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
