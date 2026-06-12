/**
 * Phase 0 / P0-8 validation: spawn the generated GitHub MCP server and connect
 * a real MCP client over stdio to confirm it initializes and exposes the tool
 * (OD-6: generated server actually works as an MCP server).
 *
 * Prereq: build the server first (npm run build in spikes/out/github-mcp-server).
 * Run: pnpm tsx spikes/mcp-client-check.ts
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "out", "github-mcp-server", "dist", "index.js");

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: "node", args: [serverEntry] });
  const client = new Client({ name: "unumcp-spike-client", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("tools exposed:", tools.map((t) => t.name));

  const createIssue = tools.find((t) => t.name === "create_issue");
  if (!createIssue) throw new Error("create_issue not exposed by the server");

  console.log("description:", createIssue.description);
  const props = (createIssue.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  console.log("input properties:", Object.keys(props));

  await client.close();
  console.log("OK: generated server loads in an MCP client and exposes the tool (OD-6)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
