/**
 * Phase 0 / P4-5 spike: can a NIM *code* model fix a real generated MCP server
 * whose implementation has a defect, with the tests frozen? Mirrors the repair
 * loop (read failure → fix implementation only → rerun) on one file.
 *
 * Operates in-place on the P0-5 generated server (reuses its node_modules), plants
 * a realistic bug in src/client/apiClient.ts (inverts the non-2xx guard), runs the
 * real vitest suite to capture the failure, asks the model to repair, rewrites the
 * file, reruns, and ALWAYS restores the original file in `finally`.
 *
 * Run (PowerShell, key loaded from apps/api/.env):
 *   node --env-file=apps/api/.env --import tsx spikes/llm-repair-github.ts
 * Optional code model (default qwen/qwen2.5-coder-32b-instruct):
 *   $env:NIM_CODE_MODEL="meta/llama-3.3-70b-instruct"
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NimClient, repairCode } from "@unumcp/llm";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, "out", "github-mcp-server");
const relPath = "src/client/apiClient.ts";
const absPath = join(projectDir, relPath);
const DEFAULT_CODE_MODEL = "qwen/qwen2.5-coder-32b-instruct";

function runTests(): { ok: boolean; output: string } {
  try {
    const out = execSync("npm test", { cwd: projectDir, encoding: "utf8", stdio: "pipe" });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.NVIDIA_API_KEY ?? process.env.NIM_API_KEY;
  if (!apiKey) {
    console.log("NVIDIA_API_KEY not set — skipping. Run: node --env-file=apps/api/.env --import tsx spikes/llm-repair-github.ts");
    return;
  }
  if (!existsSync(join(projectDir, "node_modules"))) {
    console.log(`No node_modules in ${projectDir}. Run \`npm install\` there first (P0-5 spike output).`);
    return;
  }

  const model = process.env.NIM_CODE_MODEL ?? DEFAULT_CODE_MODEL;
  const original = readFileSync(absPath, "utf8");

  try {
    // 1. Plant a realistic defect: invert the non-2xx guard.
    const broken = original.replace("if (!response.ok)", "if (response.ok)");
    if (broken === original) throw new Error("Could not plant the bug — guard text not found.");
    writeFileSync(absPath, broken);

    // 2. Capture the real failure.
    const failed = runTests();
    console.log(`Model:        ${model}`);
    console.log(`Bug planted:  inverted the non-2xx guard in ${relPath}`);
    console.log(`Tests after bug: ${failed.ok ? "PASS (unexpected!)" : "FAIL (as expected)"}`);
    if (failed.ok) throw new Error("Planted bug did not fail the tests — aborting.");

    // 3. Ask the code model to repair implementation only.
    const result = await repairCode(new NimClient({ apiKey, model, timeoutMs: 90_000 }), {
      failureLog: failed.output.slice(-4000),
      files: [{ path: relPath, content: broken }],
    });

    // 4. Apply + rerun.
    const fix = result.files.find((f) => f.path === relPath);
    if (!fix) throw new Error("Model did not return the file under repair.");
    writeFileSync(absPath, fix.content);
    const repaired = runTests();

    console.log(`\nRepair applied. Tests after fix: ${repaired.ok ? "PASS ✅" : "STILL FAILING ❌"}`);
    console.log(`Restored the guard correctly: ${fix.content.includes("if (!response.ok)")}`);
    console.log("\n— Measurements (P4-5 / NFR-007b) —");
    console.log(`  model returned: ${result.model}`);
    console.log(`  input tokens:   ${result.usage.inputTokens}`);
    console.log(`  output tokens:  ${result.usage.outputTokens}`);
    console.log(`  latency:        ${result.latencyMs} ms`);
    if (!repaired.ok) console.log(`\nRemaining failure:\n${repaired.output.slice(-1500)}`);
  } finally {
    // 5. Always restore the pristine file.
    writeFileSync(absPath, original);
    console.log(`\nRestored ${relPath} to its original content.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
