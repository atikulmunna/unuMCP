// Pure helpers for the code-preview / repair-diff panels (P4-9, §15.5).
// Kept dependency-free and testable — the heavy parts (a full editor / token
// highlighter) are intentionally out of scope for the MVP (no over-engineering).

export type DiffTone = "add" | "del" | "meta" | "context";

export interface DiffLine {
  tone: DiffTone;
  text: string;
}

/**
 * Classify each line of a unified diff (as produced by `@unumcp/llm`'s
 * `unifiedDiff`) so the UI can colour additions/removals. The file headers
 * (`--- a/…`, `+++ b/…`) and hunk markers (`@@`) are checked BEFORE the
 * single-char `+`/`-` so a `--- a/file` header isn't mistaken for a deletion.
 */
export function diffToLines(diff: string): DiffLine[] {
  if (!diff) return [];
  return diff.split("\n").map((text) => ({ tone: classify(text), text }));
}

function classify(line: string): DiffTone {
  if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** A short, human-friendly language label for a file path (preview header). */
export function fileLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    json: "JSON",
    md: "Markdown",
    yml: "YAML",
    yaml: "YAML",
    env: "dotenv",
    example: "dotenv",
  };
  return map[ext] ?? "Text";
}
