/**
 * Pure parsers for sandbox output (§16.5, NFR-002). Side-effect-free so they
 * can be unit-tested without Docker.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

/**
 * Parse a Vitest run summary from captured logs. Vitest prints both a
 * "Test Files" and a "Tests" line; we read the latter, e.g.
 * `Tests  1 failed | 8 passed (9)`. Returns all-zero when no summary is found
 * (e.g. the run crashed before tests executed).
 */
export function parseTestSummary(log: string): TestSummary {
  const line = log.match(/^[^\S\n]*Tests[^\S\n]+(.+?)\((\d+)\)[^\S\n]*$/m);
  if (!line) return { passed: 0, failed: 0, skipped: 0, total: 0 };
  const body = line[1] ?? "";
  return {
    passed: count(body, /(\d+)\s+passed/),
    failed: count(body, /(\d+)\s+failed/),
    skipped: count(body, /(\d+)\s+skipped/),
    total: Number(line[2]),
  };
}

function count(body: string, re: RegExp): number {
  const m = body.match(re);
  return m ? Number(m[1]) : 0;
}

/**
 * Bound a log to `maxBytes`, keeping the tail — Vitest failures and the summary
 * appear at the end, so the tail is the useful part for diagnosis and repair.
 */
export function truncateLog(log: string, maxBytes = 16_000): string {
  if (Buffer.byteLength(log) <= maxBytes) return log;
  return `…[truncated]\n${log.slice(-maxBytes)}`;
}
