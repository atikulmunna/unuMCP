/**
 * Live smoke for the Google Gemini provider + the P2-6 batched proposal path.
 * Describes THREE endpoints in ONE call via Gemini's OpenAI-compatible endpoint,
 * proving: the provider wiring, JSON-mode `response_format`, batch parsing, and
 * token/latency capture. No DB, no API server — just the LLM seam.
 *
 * Run (PowerShell):
 *   $env:GEMINI_API_KEY="AIza..."; pnpm tsx spikes/gemini-smoke.ts
 * Optional model override (default gemini-3.5-flash):
 *   $env:GEMINI_MODEL="gemini-3.5-pro"
 */
import { GeminiClient, proposeToolDescriptions, type ToolProposalInput } from "@unumcp/llm";

const DEFAULT_MODEL = "gemini-3.5-flash";

const inputs: ToolProposalInput[] = [
  {
    toolName: "create_issue",
    method: "post",
    path: "/repos/{owner}/{repo}/issues",
    summary: "Create an issue",
    paramNames: ["owner", "repo"],
    mutates: true,
    riskLevel: "medium",
  },
  {
    toolName: "get_issue",
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{issue_number}",
    summary: "Get an issue",
    paramNames: ["owner", "repo", "issue_number"],
    mutates: false,
    riskLevel: "low",
  },
  {
    toolName: "delete_repo",
    method: "delete",
    path: "/repos/{owner}/{repo}",
    summary: "Delete a repository",
    paramNames: ["owner", "repo"],
    mutates: true,
    riskLevel: "critical",
  },
];

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.log("GEMINI_API_KEY is not set — skipping the live call.");
    return;
  }
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const client = new GeminiClient({ apiKey, model });

  console.log(`Provider: Gemini (${model}) — describing ${inputs.length} tools in ONE batched call…\n`);
  const started = Date.now();
  const result = await proposeToolDescriptions(client, inputs);
  const wall = Date.now() - started;

  inputs.forEach((input, i) => {
    const d = result.descriptions[i];
    console.log(`• ${input.toolName} (${input.method.toUpperCase()} ${input.path})`);
    console.log(`  ${d ?? "[no description — fell back to deterministic draft]"}\n`);
  });

  const described = result.descriptions.filter((d) => d !== null).length;
  console.log("─".repeat(60));
  console.log(`described:   ${described}/${inputs.length} tools`);
  console.log(`model:       ${result.model}`);
  console.log(`tokens:      ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  console.log(`latency:     ${result.latencyMs} ms (wall ${wall} ms) — for the whole batch`);
  console.log(
    `\nPer-tool amortized: ~${Math.round(result.latencyMs / inputs.length)} ms, ` +
      `~${Math.round((result.usage.inputTokens + result.usage.outputTokens) / inputs.length)} tokens/tool.`,
  );
}

main().catch((err) => {
  console.error("Smoke failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
