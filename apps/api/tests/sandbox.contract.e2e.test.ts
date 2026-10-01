import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { generateProject, type McpToolDefinition } from "@unumcp/codegen";
import { evaluateRun, runSandbox } from "@unumcp/sandbox";

// Opt-in, like the sandbox security suite: these run generated servers' own
// contract tests in the REAL Docker sandbox (RUN_SANDBOX_DOCKER_TESTS=1).
const RUN = process.env.RUN_SANDBOX_DOCKER_TESTS;

const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required }) as McpToolDefinition["inputSchema"];

const TOOLS: McpToolDefinition[] = [
  {
    name: "get_widget",
    description: "Gets a widget.",
    method: "get",
    pathTemplate: "/widgets/{id}",
    parameters: [
      { name: "id", in: "path" },
      { name: "tags", in: "query" },
      { name: "X-Api-Version", in: "header" },
    ],
    hasBody: false,
    authRequired: true,
    riskLevel: "low",
    inputSchema: object(
      { id: { type: "string" }, tags: { type: "array", items: { type: "string" } }, "X-Api-Version": { type: "string" } },
      ["id"],
    ),
  },
  {
    name: "create_charge",
    description: "Creates a charge (modifies data).",
    method: "post",
    pathTemplate: "/v1/charges",
    parameters: [],
    hasBody: true,
    bodyMediaType: "application/x-www-form-urlencoded",
    authRequired: true,
    riskLevel: "high",
    inputSchema: object({ body: object({ amount: { type: "integer" }, metadata: object({ order: { type: "string" } }) }, ["amount"]) }, ["body"]),
  },
];

async function generatedServer(edit?: { file: string; from: string; to: string }): Promise<string> {
  const files = generateProject({
    serverName: "contract-e2e-mcp-server",
    baseUrl: "https://api.contract.test",
    auth: { type: "apiKeyHeader", envVar: "API_KEY", headerName: "X-API-Key" },
    tools: TOOLS,
  });
  const dir = await mkdtemp(join(tmpdir(), "unumcp-sbx-contract-"));
  for (const f of files) {
    await mkdir(dirname(join(dir, f.path)), { recursive: true });
    await writeFile(join(dir, f.path), f.content);
  }
  if (edit) {
    const path = join(dir, edit.file);
    const source = await readFile(path, "utf8");
    expect(source, `edit anchor in ${edit.file}`).toContain(edit.from);
    await writeFile(path, source.replace(edit.from, edit.to));
  }
  return dir;
}

describe.skipIf(!RUN)("generated servers in the real sandbox (contract tests + typecheck)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("passes its own typecheck and contract tests", async () => {
    const dir = await generatedServer();
    dirs.push(dir);
    const verdict = evaluateRun(await runSandbox({ projectDir: dir, testTimeoutMs: 120_000 }));
    expect(verdict.passed).toBe(true);
    // 3 per tool with required inputs + the server listing.
    expect(verdict.summary).toMatchObject({ passed: 7, failed: 0 });
  }, 900_000);

  it("fails on a type error before any test runs", async () => {
    const dir = await generatedServer({
      file: "src/tools/getWidget.ts",
      from: "const input = getWidgetInput.parse(args);",
      to: "const input = getWidgetInput.parse(args);\n      const broken: number = input.id;",
    });
    dirs.push(dir);
    const result = await runSandbox({ projectDir: dir, testTimeoutMs: 120_000 });
    const verdict = evaluateRun(result);
    expect(verdict.passed).toBe(false);
    expect(verdict.infraFailed).toBe(false); // a code failure: repair gets the compiler output
    expect(verdict.summary.total).toBe(0);
    expect(result.test.log).toMatch(/error TS2322/);
  }, 900_000);

  it("fails a contract test when a tool calls the wrong endpoint", async () => {
    const dir = await generatedServer({ file: "src/tools/getWidget.ts", from: '"/widgets/"', to: '"/widget/"' });
    dirs.push(dir);
    const verdict = evaluateRun(await runSandbox({ projectDir: dir, testTimeoutMs: 120_000 }));
    expect(verdict.passed).toBe(false);
    expect(verdict.summary.failed).toBe(1);
  }, 900_000);
});
