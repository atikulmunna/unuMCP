// Record the built-in sample project's usability check from one real run with
// Claude (a few cents). Start two API instances on the same database: one with
// the LLM off (LLM_DISABLED=true) and one with it on. Then:
//
//   node ../../node_modules/tsx/dist/cli.mjs scripts/record-sample.mts <llm-off api> <llm-on api>
//   e.g. http://localhost:3095/api http://localhost:3096/api
//
// The tool plan is proposed with the LLM off, so its descriptions are the
// spec's own summaries, exactly what a sample project gets. Claude then runs
// the agent usability check against them, and what it found and proposed is
// written to src/samples/acme-billing.recorded.ts.
import { writeFileSync } from "node:fs";
import { ACME_BILLING_SPEC } from "../src/samples/acme-billing.openapi";

interface Task {
  toolName: string;
  prompt: string;
  expectedArgs: unknown;
  candidateNames: string[];
  chosenTool: string | null;
  chosenArgs: unknown;
  outcome: string;
  reason: string | null;
}
interface Fix {
  toolName: string;
  afterName: string | null;
  afterDescription: string;
  missesFixed: number;
  pairedWith: string[];
}
interface Run {
  status: string;
  errorMessage: string | null;
  note: string | null;
  llmModelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: string | number;
  taskCount: number;
  answeredCount: number;
  baselineCorrect: number;
  fixedCorrect: number | null;
  tasks: Task[];
  fixes: Fix[];
}

const [offApi, onApi] = process.argv.slice(2);
if (!offApi || !onApi) throw new Error("usage: record-sample.mts <llm-off api> <llm-on api>");
const out = new URL("../src/samples/acme-billing.recorded.ts", import.meta.url);

async function call<T>(api: string, method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(api + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const { accessToken: token } = await call<{ accessToken: string }>(offApi, "POST", "/auth/register", undefined, {
  email: `record-sample-${Date.now()}@example.com`,
  password: "record-sample-password",
});
const project = await call<{ id: string }>(offApi, "POST", "/projects", token, { name: "Acme Billing (recording)" });
await call(offApi, "POST", `/projects/${project.id}/spec/upload`, token, {
  filename: "acme-billing.json",
  content: JSON.stringify(ACME_BILLING_SPEC),
});
await call(offApi, "POST", `/projects/${project.id}/tools/propose`, token);
await call(onApi, "POST", `/projects/${project.id}/usability`, token);

const { llmEnabled, run } = await call<{ llmEnabled: boolean; run: Run | null }>(
  onApi,
  "GET",
  `/projects/${project.id}/usability`,
  token,
);
if (!llmEnabled || !run || run.status !== "completed") {
  throw new Error(`The check did not complete with the LLM on: ${run?.status} ${run?.errorMessage ?? ""}`);
}

const recorded = {
  model: run.llmModelId,
  recordedOn: new Date().toISOString().slice(0, 10),
  note: run.note,
  inputTokens: run.inputTokens,
  outputTokens: run.outputTokens,
  estimatedCostUsd: String(run.estimatedCostUsd),
  taskCount: run.taskCount,
  answeredCount: run.answeredCount,
  baselineCorrect: run.baselineCorrect,
  fixedCorrect: run.fixedCorrect,
  tasks: run.tasks.map(({ toolName, prompt, expectedArgs, candidateNames, chosenTool, chosenArgs, outcome, reason }) => ({
    toolName,
    prompt,
    expectedArgs,
    candidateNames,
    chosenTool,
    chosenArgs,
    outcome,
    reason,
  })),
  fixes: run.fixes.map(({ toolName, afterName, afterDescription, missesFixed, pairedWith }) => ({
    toolName,
    afterName,
    afterDescription,
    missesFixed,
    pairedWith,
  })),
};

writeFileSync(
  out,
  `// Recorded by scripts/record-sample.mts from a real usability check with\n` +
    `// Claude on the sample spec. Regenerate it rather than editing it.\n` +
    `export const ACME_BILLING_RECORDED = ${JSON.stringify(recorded, null, 2)};\n`,
);
console.log(
  `Recorded ${recorded.baselineCorrect}/${recorded.answeredCount} -> ${recorded.fixedCorrect ?? "no fixes"}, ` +
    `${recorded.fixes.length} fix(es), $${recorded.estimatedCostUsd}.`,
);
