/**
 * Phase 0 / P0-6 validation: run the generated GitHub MCP server through the
 * two-phase Docker sandbox (OD-4, §9.8.0) and prove that:
 *   1. install phase (network on) succeeds,
 *   2. test phase (network OFF, resource-limited) still passes,
 *   3. an explicit network call inside a --network none container is blocked.
 *
 * Prereq: spikes/generate-github-server.ts has produced spikes/out/.
 * Run: pnpm tsx spikes/sandbox-run.ts
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandbox } from "@unumcp/sandbox";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, "out", "github-mcp-server");

function tail(log: string, n = 6): string {
  return log.trim().split("\n").slice(-n).join("\n");
}

/** Returns the exit code of a one-off docker run. */
function dockerExit(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}

async function main(): Promise<void> {
  console.log(`running two-phase sandbox on ${projectDir}\n`);
  const result = await runSandbox({ projectDir });

  console.log(`PHASE 1 install: ok=${result.install.ok} exit=${result.install.exitCode}`);
  console.log(tail(result.install.log), "\n");
  console.log(`PHASE 2 test (network off): ok=${result.test.ok} exit=${result.test.exitCode}`);
  console.log(tail(result.test.log), "\n");

  // Network-block proof: attempt an outbound fetch inside --network none.
  console.log("network-block proof: fetch() inside --network none ...");
  const code = await dockerExit([
    "run",
    "--rm",
    "--network",
    "none",
    "node:22-slim",
    "node",
    "-e",
    "fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(7))",
  ]);
  const networkBlocked = code !== 0;
  console.log(`  fetch exit=${code} → network blocked: ${networkBlocked}\n`);

  const pass = result.install.ok && result.test.ok && networkBlocked;
  console.log(
    pass
      ? "OK: two-phase sandbox works — offline tests pass, network is isolated (OD-4)"
      : "FAIL: sandbox validation did not fully pass",
  );
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
