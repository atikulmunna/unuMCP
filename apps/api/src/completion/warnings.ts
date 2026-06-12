/**
 * Deterministic completion-warning rules (§26.4, P5-4). Pure so the same
 * pipeline facts always yield the same warnings — used both when finalizing a
 * project and when embedding `WARNINGS.md` into a partial download.
 */
export interface WarningFacts {
  /** Auth could not be auto-detected and the user must configure it (F-1). */
  authNeedsUserConfig: boolean;
  /** Total tests the generated suite ran. */
  totalTestCount: number;
  /** Tests that failed (a completed-with-warnings build still has 0 here). */
  failingTestCount: number;
}

export function computeWarnings(facts: WarningFacts): string[] {
  const warnings: string[] = [];
  if (facts.authNeedsUserConfig) {
    warnings.push(
      "Authentication could not be auto-detected from the spec. Set the API token in .env before using this server.",
    );
  }
  if (facts.totalTestCount === 0) {
    warnings.push("No tests were generated for the selected tools.");
  }
  return warnings;
}

/** Render warnings as a `WARNINGS.md` document for inclusion in the archive. */
export function renderWarningsMarkdown(warnings: string[]): string {
  const items = warnings.map((w) => `- ${w}`).join("\n");
  return `# Build Warnings

This server was generated and packaged, but completed **with warnings**. Review the
following before deploying it:

${items}
`;
}
