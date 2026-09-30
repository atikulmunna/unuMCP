/**
 * Deterministic completion-warning rules (§26.4, P5-4). Pure so the same
 * pipeline facts always yield the same warnings — used both when finalizing a
 * project and when embedding `WARNINGS.md` into a download.
 */

/** How the stored code fared in its latest test run (none yet is `not_run`). */
export type TestOutcome = "passed" | "failed" | "errored" | "not_run";

/** Map a stored `TestResult.status` (or its absence) to a {@link TestOutcome}. */
export function testOutcomeOf(status: string | null | undefined): TestOutcome {
  return status === "passed" || status === "failed" || status === "errored" ? status : "not_run";
}

export interface WarningFacts {
  /** Auth could not be auto-detected and the user must configure it (F-1). */
  authNeedsUserConfig: boolean;
  /** Outcome of the latest test run of the code being shipped. */
  testOutcome: TestOutcome;
  /** Total tests that run reported. */
  totalTestCount: number;
  /** Tests that failed in that run. */
  failingTestCount: number;
}

export function computeWarnings(facts: WarningFacts): string[] {
  const warnings: string[] = [];
  if (facts.authNeedsUserConfig) {
    warnings.push(
      "Authentication could not be auto-detected from the spec. Set the API token in .env before using this server.",
    );
  }
  switch (facts.testOutcome) {
    case "failed":
      warnings.push(
        facts.totalTestCount > 0
          ? `Tests did not pass: ${facts.failingTestCount} of ${facts.totalTestCount} failed in the sandbox. Fix the failing tools before using this server.`
          : "Tests did not pass: the sandbox run reported no passing tests, so this server is untested.",
      );
      break;
    case "errored":
      warnings.push(
        "The sandbox could not run the tests (an infrastructure error, not a verdict on the code), so this server is untested.",
      );
      break;
    case "not_run":
      warnings.push("Tests have not been run for this build, so this server is untested.");
      break;
    case "passed":
      if (facts.totalTestCount === 0) {
        warnings.push("No tests were generated for the selected tools.");
      }
      break;
  }
  return warnings;
}

/** Render warnings as a `WARNINGS.md` document for inclusion in the archive. */
export function renderWarningsMarkdown(warnings: string[]): string {
  const items = warnings.map((w) => `- ${w}`).join("\n");
  return `# Build Warnings

This server was generated and packaged **with warnings**. Review the following
before deploying it:

${items}
`;
}
