// Helpers for reading model output, shared by the prompt modules.

/** Obvious credential shapes that must never appear in model-written tool text. */
export const SECRET_SHAPE = /\b(?:sk-[a-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,})\b/;

/** Pull the first {...} block, stripping ```json fences if present. */
export function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in LLM output: ${text.slice(0, 200)}`);
  }
  return candidate.slice(start, end + 1);
}
