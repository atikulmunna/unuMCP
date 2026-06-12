/**
 * Phase 4 / P4-3 validation: prove the PRODUCTIONIZED sandbox path end-to-end
 * against real Docker — generate a server, materialize it into a CLEAN temp dir
 * (no host node_modules, finding F-3), run the real two-phase sandbox, and parse
 * the real Vitest output the same way TestingService does.
 *
 * Run: pnpm tsx spikes/phase4-sandbox.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dereferenceSpec, extractEndpoints, type ExtractedEndpoint } from "@unumcp/openapi";
import type { JsonSchema } from "@unumcp/openapi";
import { generateProject, type McpToolDefinition } from "@unumcp/codegen";
import { runSandbox, parseTestSummary } from "@unumcp/sandbox";

const here = dirname(fileURLToPath(import.meta.url));

function toToolDefinition(ep: ExtractedEndpoint): McpToolDefinition {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const parameters: McpToolDefinition["parameters"] = [];
  for (const p of ep.parameters) {
    if (p.in !== "path" && p.in !== "query") continue;
    properties[p.name] = (p.schema ?? { type: "string" }) as JsonSchema;
    if (p.required) required.push(p.name);
    parameters.push({ name: p.name, in: p.in });
  }
  if (ep.requestSchema) {
    properties["body"] = ep.requestSchema;
    required.push("body");
  }
  return {
    name: "create_issue",
    description: "Create a new issue in a GitHub repository.",
    inputSchema: { type: "object", properties, required } as JsonSchema,
    method: ep.method,
    pathTemplate: ep.path,
    parameters,
    hasBody: Boolean(ep.requestSchema),
    authRequired: ep.authRequired,
    riskLevel: "medium",
  };
}

async function main(): Promise<void> {
  const spec = JSON.parse(readFileSync(join(here, "specs", "github.json"), "utf8"));
  const deref = await dereferenceSpec(spec);
  const ep = extractEndpoints(deref).find((e) => e.operationId === "issues/create");
  if (!ep) throw new Error("issues/create not found");

  const files = generateProject({
    serverName: "github-mcp-server",
    baseUrl: "https://api.github.com",
    auth: { type: "bearer", envVar: "GITHUB_TOKEN" },
    tools: [toToolDefinition(ep)],
  });

  // Materialize into a CLEAN temp dir, exactly like TestingService does.
  const dir = mkdtempSync(join(tmpdir(), "unumcp-sbx-it-"));
  try {
    for (const f of files) {
      const full = join(dir, f.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.content);
    }
    console.log(`materialized ${files.length} files into ${dir}`);
    console.log("running two-phase sandbox (real Docker)…");

    const result = await runSandbox({ projectDir: dir });
    const summary = parseTestSummary(result.test.log);
    console.log("install ok:", result.install.ok);
    console.log("test ok:", result.test.ok, "timedOut:", result.test.timedOut);
    console.log("parsed summary:", JSON.stringify(summary));
    console.log("--- test log tail ---");
    console.log(result.test.log.slice(-600));

    if (!(result.install.ok && result.test.ok && summary.failed === 0 && summary.total > 0)) {
      throw new Error("sandbox did not pass as expected");
    }
    console.log("\n✅ P4-3 real-Docker path verified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
