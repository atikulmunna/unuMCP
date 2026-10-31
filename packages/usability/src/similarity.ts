import type { UsabilityTool } from "./types";

/** How many tools the simulated agent sees per task: the target plus 11 look-alikes. */
export const CANDIDATE_COUNT = 12;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "are", "was", "will", "can", "you",
  "your", "its", "into", "about", "when", "which", "also", "has", "have", "not", "one", "all",
  "any", "each", "than", "then", "there", "their", "them", "they", "been", "being", "only",
  "more", "most", "such", "may", "must",
]);

/** Fold simple plurals so "issues" and "issue" count as the same word. */
function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(singular);
}

interface Tokens {
  /** Path segments (parameters left out) and tag: which resource the tool acts on. */
  resource: Set<string>;
  name: Set<string>;
  description: Set<string>;
}

function tokensOf(tool: UsabilityTool): Tokens {
  const segments = tool.path.split("/").filter((s) => s.length > 0 && !s.startsWith("{"));
  return {
    resource: new Set([...segments.flatMap(words), ...words(tool.tag ?? "")]),
    name: new Set(words(tool.name)),
    description: new Set(
      (tool.description.toLowerCase().match(/[a-z]{3,}/g) ?? [])
        .filter((w) => !STOP_WORDS.has(w))
        .map(singular),
    ),
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function similarityOf(a: Tokens, b: Tokens): number {
  // The resource counts double: tools on the same resource (get vs list vs
  // update an issue) are the ones an agent actually mixes up.
  return 2 * jaccard(a.resource, b.resource) + jaccard(a.name, b.name) + jaccard(a.description, b.description);
}

/** How alike two tools look to an agent, from 0 (nothing shared) to 4 (identical). */
export function similarity(a: UsabilityTool, b: UsabilityTool): number {
  return similarityOf(tokensOf(a), tokensOf(b));
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The tools the agent chooses from for one task: the target and its closest
 * look-alikes, or every tool when there are no more than `size`. Returned in
 * name order, so the target's position never gives the answer away.
 */
export function selectCandidates(
  target: UsabilityTool,
  tools: UsabilityTool[],
  size = CANDIDATE_COUNT,
): UsabilityTool[] {
  const targetTokens = tokensOf(target);
  const others = tools
    .filter((t) => t.name !== target.name)
    .map((t) => ({ tool: t, score: similarityOf(targetTokens, tokensOf(t)) }))
    .sort((a, b) => b.score - a.score || byName(a.tool, b.tool))
    .slice(0, size - 1)
    .map((r) => r.tool);
  return [target, ...others].sort(byName);
}

/**
 * Up to `cap` tools to test, most confusable first: ranked by how close each
 * tool's nearest look-alike is, ties broken by name.
 */
export function pickTargets(tools: UsabilityTool[], cap: number): UsabilityTool[] {
  const tokens = tools.map(tokensOf);
  return tools
    .map((tool, i) => {
      let closest = 0;
      for (let j = 0; j < tools.length; j++) {
        if (j !== i) closest = Math.max(closest, similarityOf(tokens[i]!, tokens[j]!));
      }
      return { tool, closest };
    })
    .sort((a, b) => b.closest - a.closest || byName(a.tool, b.tool))
    .slice(0, cap)
    .map((r) => r.tool);
}
