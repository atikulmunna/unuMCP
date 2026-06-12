import type { LlmClient, LlmUsage } from "./types";

export interface RepairFile {
  path: string;
  content: string;
}

export interface RepairInput {
  /** Failing test output (stdout+stderr), the signal the model repairs from. */
  failureLog: string;
  /** Implementation files the model is allowed to edit. Tests are NOT included. */
  files: RepairFile[];
  maxTokens?: number;
}

export interface RepairResult {
  /** Full corrected content of each file the model changed. */
  files: RepairFile[];
  usage: LlmUsage;
  model: string;
  latencyMs: number;
}

const SYSTEM_PROMPT = [
  "You repair a failing TypeScript MCP server. You are given the failing test output and the implementation file(s).",
  "Rules:",
  "- Edit ONLY the implementation files provided. NEVER modify or reference test files.",
  "- Make the minimal change that makes the failing tests pass. Do not refactor.",
  "- Do not change public behavior beyond fixing the defect.",
  "- For EACH file you change, output it in exactly this format, with the file's ENTIRE corrected content:",
  "<<<FILE: relative/path/to/file.ts>>>",
  "```ts",
  "...entire corrected file content...",
  "```",
  "- Output nothing else: no explanations, no prose, no extra files.",
].join("\n");

// <<<FILE: path>>> followed by a fenced code block.
const FILE_BLOCK = /<<<FILE:\s*(.+?)\s*>>>\s*```[a-zA-Z]*\n([\s\S]*?)```/g;

function isTestPath(path: string): boolean {
  return path.includes("/tests/") || path.startsWith("tests/") || /\.test\.[tj]s$/.test(path);
}

/**
 * One LLM repair pass (P4-5, FR-026, §11.4): read failure → fix implementation →
 * (caller reruns). Tests stay frozen — the prompt forbids editing them and the
 * parser rejects any test path or any path not in the provided set, so a model
 * can't "fix" the test to make it pass or write outside the given files.
 */
export async function repairCode(client: LlmClient, input: RepairInput): Promise<RepairResult> {
  const allowed = new Set(input.files.map((f) => f.path));

  const fileBlocks = input.files
    .map((f) => `<<<FILE: ${f.path}>>>\n\`\`\`ts\n${f.content}\n\`\`\``)
    .join("\n\n");

  const completion = await client.complete({
    temperature: 0,
    maxTokens: input.maxTokens ?? 2048,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Failing test output:\n\n${input.failureLog}\n\nImplementation file(s) you may edit:\n\n${fileBlocks}`,
      },
    ],
  });

  const files = parseRepairFiles(completion.text, allowed);
  return {
    files,
    usage: completion.usage,
    model: completion.model,
    latencyMs: completion.latencyMs,
  };
}

/** Extract `<<<FILE: path>>>` + fenced-block pairs, enforcing the edit allowlist. */
export function parseRepairFiles(text: string, allowed: ReadonlySet<string>): RepairFile[] {
  const files: RepairFile[] = [];
  for (const match of text.matchAll(FILE_BLOCK)) {
    const path = match[1]?.trim();
    const content = match[2];
    if (!path || content === undefined) continue;
    if (isTestPath(path)) {
      throw new Error(`Repair attempted to edit a frozen test file: ${path}`);
    }
    if (!allowed.has(path)) {
      throw new Error(`Repair returned a file outside the editable set: ${path}`);
    }
    files.push({ path, content: content.endsWith("\n") ? content : content + "\n" });
  }
  if (files.length === 0) {
    throw new Error(`Repair produced no <<<FILE: …>>> blocks: ${text.slice(0, 200)}`);
  }
  return files;
}
