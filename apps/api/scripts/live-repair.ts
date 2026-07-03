/**
 * LIVE repair-loop run (not a unit test). Drives the real API to TESTS_FAILED by
 * planting a realistic defect in a *persisted* generated source artifact, then
 * lets the inline repair loop (LLM enabled) fix it: read failure → LLM patches
 * implementation-only → rerun sandbox → TESTS_PASSED. Proves P4-5/P4-6 live with
 * whichever provider is auto-selected (Gemini).
 *
 * Run from apps/api (swc for decorators), 1 attempt to bound wall time:
 *   DATABASE_URL=postgresql://unumcp:unumcp@localhost:5434/unumcp?schema=public \
 *   MAX_REPAIR_ATTEMPTS=1 \
 *   node -r @swc-node/register --env-file=.env scripts/live-repair.ts
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/storage/storage.service";
import { LlmService } from "../src/llm/llm.service";

const PORT = Number(process.env.LIVE_E2E_PORT ?? 3098);
const BASE = `http://localhost:${PORT}/api`;

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Catalog", version: "1.0.0" },
  servers: [{ url: "https://api.catalog.test" }],
  security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List all widgets",
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    },
  },
});

let token = "";
async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return data;
}
function safeJson(t: string): unknown {
  try { return JSON.parse(t); } catch { return t; }
}
function step(n: number, msg: string): void { console.log(`\n[${n}] ${msg}`); }

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ["warn", "error"] });
  app.setGlobalPrefix("api");
  await app.listen(PORT);
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);
  const llm = app.get(LlmService);
  const email = `live-repair-${Date.now()}@example.com`;

  console.log(`LLM enabled: ${llm.enabled}  |  MAX_REPAIR_ATTEMPTS=${process.env.MAX_REPAIR_ATTEMPTS ?? "2"}`);
  if (!llm.enabled) {
    console.error("LLM disabled — set GEMINI_API_KEY. Aborting.");
    await app.close();
    process.exitCode = 1;
    return;
  }

  try {
    step(1, "Register → project → upload → propose → approve → generate");
    token = (await call("POST", "/auth/register", { email, password: "password123" })).accessToken;
    const id = (await call("POST", "/projects", { name: "Repair Live" })).id;
    await call("POST", `/projects/${id}/spec/upload`, { filename: "catalog.json", content: spec });
    await call("POST", `/projects/${id}/tools/propose`);
    await call("POST", `/projects/${id}/tools/approve`);
    const gen = await call("POST", `/projects/${id}/generation`);
    console.log(`    ✓ generated ${gen.fileCount ?? "?"} files`);

    step(2, "Plant a realistic defect in a PERSISTED source artifact");
    const sources = await prisma.generatedArtifact.findMany({
      where: { projectId: id, artifactType: "source_file", contentUrl: { not: null } },
    });
    let planted: { path: string } | null = null;
    for (const a of sources) {
      const content = await storage.read(a.contentUrl as string);
      if (content.includes("if (!response.ok)")) {
        // Invert the non-2xx guard → the generated "throws on a non-2xx response" test fails.
        const broken = content.replace("if (!response.ok)", "if (response.ok)");
        await storage.save(a.contentUrl as string, broken);
        planted = { path: a.path };
        break;
      }
    }
    if (!planted) throw new Error("Could not find the non-2xx guard to plant a bug.");
    console.log(`    ✓ inverted the non-2xx guard in ${planted.path}`);

    step(3, "Run tests → expect FAIL → inline repair loop (LLM) → rerun (this takes a few minutes)");
    const t0 = Date.now();
    await call("POST", `/projects/${id}/test`);
    console.log(`    ✓ test+repair cycle returned in ${Math.round((Date.now() - t0) / 1000)}s`);

    step(4, "Final project state");
    const project = await call("GET", `/projects/${id}`);
    console.log(`    → status = ${project.status}`);

    step(5, "Repair attempts recorded (P4-6)");
    const run = await prisma.generationRun.findFirst({ where: { projectId: id }, orderBy: { startedAt: "desc" } });
    const attempts = await prisma.repairAttempt.findMany({
      where: { generationRunId: run?.id },
      orderBy: { attemptNumber: "asc" },
    });
    for (const at of attempts) {
      console.log(`      • attempt ${at.attemptNumber}: ${at.outcome} (diff ${at.diff.length} chars)`);
    }

    step(6, "Audit trail — repair events + FR-031 repair_code trace");
    const audit = await call("GET", `/projects/${id}/audit`);
    const traces = audit.filter((e: any) => e.eventType === "llm_tool_call");
    const repairTrace = traces.find((e: any) => e.metadata?.toolName === "repair_code");
    console.log(`      • llm_tool_call traces: ${traces.map((e: any) => e.metadata?.toolName).join(", ")}`);
    if (repairTrace) console.log(`      • repair_code trace: ${JSON.stringify(repairTrace.metadata)}`);
    console.log(`      • repair_attempt events: ${audit.filter((e: any) => e.eventType === "repair_attempt").length}`);

    const verdict = project.status === "TESTS_PASSED" ? "REPAIRED ✅" : `NOT repaired (${project.status})`;
    console.log(`\n=== LIVE REPAIR: ${verdict} ===`);

    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("\nLIVE REPAIR FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
