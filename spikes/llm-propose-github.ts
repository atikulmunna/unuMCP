/**
 * Phase 0 / P0-4 spike (resumed): propose + name ONE tool for the GitHub
 * `issues/create` endpoint using a real LLM call — now via NVIDIA NIM instead of
 * Anthropic (decision: use the NIM key we already have; stack note in tasks.md).
 *
 * Naming + classification + risk stay DETERMINISTIC (`@unumcp/analysis`); only
 * the human-facing description is model-authored (`@unumcp/llm`, FR-013). Records
 * real input/output tokens + wall-clock latency for OD-5 / P0-7.
 *
 * Run (PowerShell):
 *   $env:NVIDIA_API_KEY="nvapi-..."; pnpm tsx spikes/llm-propose-github.ts
 * Optional model override (default meta/llama-3.3-70b-instruct):
 *   $env:NIM_MODEL="nvidia/llama-3.3-nemotron-super-49b-v1"
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dereferenceSpec, extractEndpoints } from "@unumcp/openapi";
import { classifyEndpoint, generateToolName, scoreRisk } from "@unumcp/analysis";
import { NimClient, proposeToolDescription } from "@unumcp/llm";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = "meta/llama-3.3-70b-instruct";

async function main(): Promise<void> {
  const apiKey = process.env.NVIDIA_API_KEY ?? process.env.NIM_API_KEY;
  if (!apiKey) {
    console.log(
      [
        "NVIDIA_API_KEY is not set — skipping the live call.",
        "",
        "To run the real spike (PowerShell):",
        '  $env:NVIDIA_API_KEY="nvapi-..."; pnpm tsx spikes/llm-propose-github.ts',
        "",
        "The package + its 9 unit tests already pass offline; this only adds the live measurement.",
      ].join("\n"),
    );
    return;
  }

  const model = process.env.NIM_MODEL ?? DEFAULT_MODEL;
  const spec = JSON.parse(readFileSync(join(here, "specs", "github.json"), "utf8"));
  const deref = await dereferenceSpec(spec);
  const ep = extractEndpoints(deref).find((e) => e.operationId === "issues/create");
  if (!ep) throw new Error("issues/create not found in the GitHub spec");

  // Deterministic naming/classification/risk (no LLM here).
  const operationType = classifyEndpoint(ep);
  const toolName = generateToolName(ep, operationType);
  const riskLevel = scoreRisk(ep, operationType);
  const paramNames = ep.parameters.filter((p) => p.in === "path" || p.in === "query").map((p) => p.name);

  console.log(`Model:       ${model}`);
  console.log(`Endpoint:    ${ep.method.toUpperCase()} ${ep.path}`);
  console.log(`Tool name:   ${toolName}   (operation=${operationType}, risk=${riskLevel})`);

  const proposal = await proposeToolDescription(new NimClient({ apiKey, model }), {
    toolName,
    method: ep.method,
    path: ep.path,
    summary: ep.summary,
    specDescription: ep.description,
    paramNames,
    mutates: ep.method.toLowerCase() !== "get",
    riskLevel,
  });

  console.log(`\nDescription: ${proposal.description}\n`);
  console.log("— Measurements (OD-5 / P0-7) —");
  console.log(`  model returned:  ${proposal.model}`);
  console.log(`  input tokens:    ${proposal.usage.inputTokens}`);
  console.log(`  output tokens:   ${proposal.usage.outputTokens}`);
  console.log(`  latency:         ${proposal.latencyMs} ms`);
  console.log(
    "\nNote: NIM hosted catalog has no Anthropic-style prompt caching; amortize big specs via batching + bounded concurrency (the BullMQ path).",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
