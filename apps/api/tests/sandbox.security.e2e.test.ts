import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSandbox } from "@unumcp/sandbox";
import { redactSecrets } from "@unumcp/security-scan";

// Opt-in: these spin up the REAL two-phase Docker sandbox, so they only run when
// RUN_SANDBOX_DOCKER_TESTS is set (like the real-Redis queue test gates on
// REDIS_URL). The default suite skips them — the pure builders/limits are unit-
// tested in @unumcp/sandbox, and the redaction is unit-tested in security-scan;
// these prove the two security properties end-to-end against real Docker (§18.3).
const RUN = process.env.RUN_SANDBOX_DOCKER_TESTS;

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unumcp-sbx-sec-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe.skipIf(!RUN)("sandbox security (P4-10, §18.3 — real Docker, opt-in)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("kills a non-terminating test via the phase timeout (SIGKILL)", async () => {
    const dir = await makeProject({
      "package.json": JSON.stringify({ name: "loop", private: true, scripts: { test: "node loop.js" } }),
      "loop.js": "while (true) {}\n",
    });
    dirs.push(dir);

    // A short test-phase timeout keeps this fast; the infinite loop can never finish.
    const result = await runSandbox({ projectDir: dir, installTimeoutMs: 60_000, testTimeoutMs: 8_000 });

    expect(result.install.ok).toBe(true);
    expect(result.test.timedOut).toBe(true);
    expect(result.test.ok).toBe(false);
  }, 180_000);

  it("a secret printed inside the sandbox does not survive redaction", async () => {
    const token = `ghp_${"a".repeat(36)}`; // GitHub-PAT-shaped, matched by redactSecrets
    const dir = await makeProject({
      "package.json": JSON.stringify({ name: "leak", private: true, scripts: { test: "node leak.js" } }),
      "leak.js": `console.log("config token: ${token}");\n`,
    });
    dirs.push(dir);

    const result = await runSandbox({ projectDir: dir, installTimeoutMs: 60_000, testTimeoutMs: 30_000 });

    expect(result.test.ok).toBe(true);
    // The raw secret really did reach the sandbox's stdout…
    expect(result.test.log).toContain(token);
    // …but the production redaction (what TestingService persists/shows) scrubs it.
    const persisted = redactSecrets(result.test.log);
    expect(persisted).not.toContain(token);
    expect(persisted).toContain("***REDACTED***");
  }, 180_000);
});
