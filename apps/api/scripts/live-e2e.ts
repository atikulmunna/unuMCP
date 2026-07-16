/**
 * LIVE end-to-end pipeline run (not a unit test). Boots the real API in-process
 * (global `api` prefix, real Docker sandbox, LLM enabled) and drives the full
 * flow over HTTP with a live LLM: register → project → upload spec → propose
 * (LIVE) → approve → generate → sandbox test → complete → download → audit.
 *
 * Run from apps/api (so @swc-node/register emits decorator metadata):
 *   DATABASE_URL=postgresql://unumcp:unumcp@localhost:5434/unumcp?schema=public \
 *   node -r @swc-node/register --env-file=.env scripts/live-e2e.ts
 *
 * DATABASE_URL is overridden on the shell so we never touch the .env's DB.
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmService } from "../src/llm/llm.service";

const PORT = Number(process.env.LIVE_E2E_PORT ?? 3099);
const BASE = `http://localhost:${PORT}/api`;

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Catalog", version: "1.0.0" },
  servers: [{ url: "https://api.catalog.test" }],
  security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  paths: {
    "/widgets": readEndpoint("listWidgets", "List all widgets in the catalog"),
    "/gadgets": readEndpoint("listGadgets", "List all gadgets in the catalog"),
    "/gizmos": readEndpoint("listGizmos", "List all gizmos in the catalog"),
  },
});

function readEndpoint(operationId: string, summary: string) {
  return {
    get: {
      operationId,
      summary,
      responses: {
        "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } },
      },
    },
  };
}

let token = "";
async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return data;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function step(n: number, msg: string): void {
  console.log(`\n[${n}] ${msg}`);
}

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ["warn", "error"] });
  app.setGlobalPrefix("api");
  await app.listen(PORT);
  const prisma = app.get(PrismaService);
  const llm = app.get(LlmService);
  const email = `live-e2e-${Date.now()}@example.com`;

  console.log(`LLM enabled: ${llm.enabled}  (provider auto-selected from env)`);
  if (!llm.enabled) {
    console.error("LLM is DISABLED — set GEMINI_API_KEY (or NVIDIA_API_KEY) in apps/api/.env. Aborting.");
    await app.close();
    process.exitCode = 1;
    return;
  }

  try {
    step(1, "Register a user");
    token = (await call("POST", "/auth/register", { email, password: "password123" })).accessToken;
    console.log(`    ✓ ${email}`);

    step(2, "Create a project");
    const project = await call("POST", "/projects", { name: "Live Catalog" });
    const id = project.id;
    console.log(`    ✓ project ${id}`);

    step(3, "Upload a secured 3-endpoint spec");
    const up = await call("POST", `/projects/${id}/spec/upload`, { filename: "catalog.json", content: spec });
    console.log(`    ✓ ${up.endpointCount} endpoints, detectedAuth=${JSON.stringify(up.detectedAuth?.required ?? up.detectedAuth)}`);

    step(4, "Propose tools (LIVE LLM)");
    const started = Date.now();
    const tools = await call("POST", `/projects/${id}/tools/propose`);
    console.log(`    ✓ ${tools.length} tools proposed in ${Date.now() - started} ms — LLM descriptions:`);
    for (const t of tools) {
      console.log(`      • ${t.name} [${t.riskLevel}]  ${t.description}`);
    }

    step(5, "Approve the enabled tools");
    const approved = await call("POST", `/projects/${id}/tools/approve`);
    console.log(`    ✓ approved ${approved.approvedCount} tools`);

    step(6, "Generate the MCP server");
    const gen = await call("POST", `/projects/${id}/generation`);
    console.log(`    ✓ run ${gen.runId ?? gen.jobId ?? "?"} — ${gen.fileCount ?? "?"} files`);

    step(7, "Run the two-phase Docker sandbox (real; ~60-90s)");
    const t0 = Date.now();
    const test = await call("POST", `/projects/${id}/test`);
    const rows = Array.isArray(test) ? test : (test.results ?? []);
    console.log(`    ✓ sandbox finished in ${Date.now() - t0} ms`);
    for (const r of rows) {
      console.log(`      • ${r.suite}: ${r.status} (${r.totalTestCount - r.failingTestCount}/${r.totalTestCount} passed, ${r.durationMs}ms)`);
    }

    step(8, "Check project reached a terminal test state");
    const afterTest = await call("GET", `/projects/${id}`);
    console.log(`    → status = ${afterTest.status}`);

    if (afterTest.status === "TESTS_PASSED") {
      step(9, "Complete the project");
      const done = await call("POST", `/projects/${id}/complete`);
      console.log(`    ✓ status = ${done.status}, warnings = ${JSON.stringify(done.warnings ?? [])}`);

      step(10, "Download the packaged ZIP");
      const zipRes = await fetch(`${BASE}/projects/${id}/generation/download`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const bytes = Buffer.from(await zipRes.arrayBuffer());
      console.log(`    ✓ ${zipRes.headers.get("content-type")} — ${bytes.length} bytes, ${zipRes.headers.get("content-disposition")}`);
    } else {
      console.log(`    ! tests did not pass (status ${afterTest.status}); skipping complete/download.`);
    }

    step(11, "Audit trail (incl. FR-031 internal LLM tool-call trace)");
    const audit = await call("GET", `/projects/${id}/audit`);
    const byType = new Map<string, number>();
    for (const e of audit) byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);
    for (const [type, n] of byType) console.log(`      • ${type} ×${n}`);
    const trace = audit.find((e: any) => e.eventType === "llm_tool_call");
    if (trace) {
      console.log(`    ✓ llm_tool_call trace present: ${JSON.stringify(trace.metadata)}`);
    } else {
      console.log(`    ! no llm_tool_call trace found`);
    }

    step(12, "LLM token/cost on the run + /metrics (P6-7, NFR-007b)");
    const run = await prisma.generationRun.findFirst({ where: { projectId: id }, orderBy: { startedAt: "desc" } });
    console.log(`    run tokens: ${run?.inputTokens} in / ${run?.outputTokens} out, est $${run?.estimatedCostUsd} (${run?.llmModelId})`);
    const metrics = await call("GET", "/metrics");
    console.log(`    /metrics cost: ${JSON.stringify(metrics.cost)}`);

    console.log("\n=== LIVE END-TO-END: DONE ===");
    // Clean up: cascade-delete the user removes the project + all children.
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("\nLIVE E2E FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
