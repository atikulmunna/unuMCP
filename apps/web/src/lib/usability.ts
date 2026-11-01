// Pure helpers for the agent usability panel, kept testable without React.

interface ScoreCounts {
  taskCount: number;
  answeredCount: number;
  baselineCorrect: number;
  fixedCorrect: number | null;
}

const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

/** "Agents chose the right tool for 33 of 40 tasks (83%). With the suggested fixes: 38 of 40 (95%)." */
export function usabilityScoreLine(run: ScoreCounts): string {
  const { taskCount, answeredCount, baselineCorrect, fixedCorrect } = run;
  const parts = [
    `Agents chose the right tool for ${baselineCorrect} of ${answeredCount} tasks (${percent(baselineCorrect, answeredCount)}%).`,
  ];
  if (fixedCorrect !== null) {
    parts.push(`With the suggested fixes: ${fixedCorrect} of ${answeredCount} (${percent(fixedCorrect, answeredCount)}%).`);
  }
  const unanswered = taskCount - answeredCount;
  if (unanswered > 0) {
    parts.push(
      unanswered === 1
        ? "1 task got no answer and is not counted."
        : `${unanswered} tasks got no answer and are not counted.`,
    );
  }
  return parts.join(" ");
}

interface FixCounts {
  missesFixed: number;
  pairedWith: string[];
}

/**
 * "fixes 1 miss", "goes with fetch_entries", or both: what a suggested fix
 * does, for its card. A fix for a tool the agent only picked by mistake fixes
 * no miss itself; it goes with the fix for the tool it was confused with.
 */
export function fixImpact(fix: FixCounts): string {
  const parts: string[] = [];
  if (fix.missesFixed > 0) parts.push(`fixes ${fix.missesFixed} ${fix.missesFixed === 1 ? "miss" : "misses"}`);
  if (fix.pairedWith.length > 0) parts.push(`goes with ${listOf(fix.pairedWith)}`);
  return parts.join(" · ");
}

const listOf = (names: string[]) =>
  names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
