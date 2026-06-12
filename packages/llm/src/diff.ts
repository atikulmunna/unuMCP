export interface DiffLine {
  type: "add" | "del";
  text: string;
}

/**
 * Minimal LCS line diff: the edit script (deletions + additions) that turns
 * `oldText` into `newText`. Pure and dependency-free so a repair attempt's diff
 * can be computed and unit-tested without a diff library (§13.6b).
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

/**
 * A compact unified-diff-style block for one file, listing only changed lines
 * (`-` removed, `+` added). Empty string when the file is unchanged.
 */
export function unifiedDiff(oldText: string, newText: string, path: string): string {
  const lines = diffLines(oldText, newText);
  if (lines.length === 0) return "";
  const body = lines.map((l) => (l.type === "del" ? "-" : "+") + l.text).join("\n");
  return `--- a/${path}\n+++ b/${path}\n${body}`;
}
