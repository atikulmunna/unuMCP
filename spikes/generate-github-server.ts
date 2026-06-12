/**
 * Phase 0 / P0-5 validation: generate a real, compilable MCP server for the
 * GitHub `issues/create` endpoint and write it to spikes/out/.
 *
 * The tool NAME and DESCRIPTION are hand-authored here, standing in for the
 * LLM's P0-4 output (which is blocked on an API key). Everything else — input
 * schema, handler, client, tests — is deterministic codegen.
 *
 * Run: pnpm tsx spikes/generate-github-server.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dereferenceSpec, extractEndpoints, type ExtractedEndpoint } from "@unumcp/openapi";
import type { JsonSchema } from "@unumcp/openapi";
import { generateProject, type McpToolDefinition } from "@unumcp/codegen";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out", "github-mcp-server");

function toToolDefinition(
  ep: ExtractedEndpoint,
  name: string,
  description: string,
): McpToolDefinition {
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
    name,
    description,
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
  const spec = JSON.parse(
    readFileSync(join(here, "specs", "github.json"), "utf8"),
  );
  const deref = await dereferenceSpec(spec);
  const endpoints = extractEndpoints(deref);
  const ep = endpoints.find((e) => e.operationId === "issues/create");
  if (!ep) throw new Error("issues/create not found");

  const tool = toToolDefinition(
    ep,
    "create_issue",
    "Create a new issue in a GitHub repository. Requires a token with repo write access. Specify the owner, repo, and an issue body containing at least a title.",
  );

  const files = generateProject({
    serverName: "github-mcp-server",
    displayName: "GitHub Issues MCP Server",
    baseUrl: "https://api.github.com",
    auth: { type: "bearer", envVar: "GITHUB_TOKEN" },
    tools: [tool],
  });

  rmSync(outDir, { recursive: true, force: true });
  for (const file of files) {
    const full = join(outDir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
  }

  console.log(`generated ${files.length} files into ${outDir}`);
  for (const f of files) console.log("  " + f.path);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
