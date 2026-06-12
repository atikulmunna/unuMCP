/**
 * Phase 0 / P0-2 validation: run the deterministic openapi module against the
 * real GitHub REST API spec and prove OD-1 (no unresolved $ref reaches
 * downstream) on a large, messy, real-world document.
 *
 * Run: pnpm tsx spikes/dereference-github.ts
 */
import { readFileSync } from "node:fs";
import {
  dereferenceSpec,
  extractEndpoints,
  hasUnresolvedRef,
} from "@unumcp/openapi";

async function main(): Promise<void> {
  const specPath = new URL("./specs/github.json", import.meta.url);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));

  console.log(
    `spec: openapi ${spec.openapi} | paths ${Object.keys(spec.paths).length} | schemas ${Object.keys(spec.components.schemas).length}`,
  );

  console.time("dereference");
  const deref = await dereferenceSpec(spec);
  console.timeEnd("dereference");

  const unresolved = hasUnresolvedRef(deref);
  console.log(`unresolved $ref remaining: ${unresolved}`);

  console.time("extract");
  const endpoints = extractEndpoints(deref);
  console.timeEnd("extract");

  console.log(`endpoints extracted: ${endpoints.length}`);
  console.log(`auth-required: ${endpoints.filter((e) => e.authRequired).length}`);
  console.log(`deprecated: ${endpoints.filter((e) => e.deprecated).length}`);
  console.log(
    `with response schema: ${endpoints.filter((e) => e.responseSchema).length}`,
  );
  console.log(
    `with request schema: ${endpoints.filter((e) => e.requestSchema).length}`,
  );

  const sample =
    endpoints.find((e) => e.operationId === "repos/get") ?? endpoints[0];
  console.log(
    "sample:",
    JSON.stringify(
      {
        method: sample.method,
        path: sample.path,
        operationId: sample.operationId,
        parameters: sample.parameters.length,
        authRequired: sample.authRequired,
        hasResponseSchema: Boolean(sample.responseSchema),
      },
      null,
      2,
    ),
  );

  if (unresolved) {
    console.error("FAIL: unresolved $ref found");
    process.exit(1);
  }
  console.log("OK: OD-1 holds on the GitHub spec");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
