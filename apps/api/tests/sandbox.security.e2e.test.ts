import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CONTAINER_NAME_PREFIX, runSandbox } from "@unumcp/sandbox";
import { redactSecrets } from "@unumcp/security-scan";

// Opt-in: these run the REAL Docker sandbox (building its image on first use),
// so they only run when RUN_SANDBOX_DOCKER_TESTS is set (like the real-Redis
// queue test gates on REDIS_URL). The pure argument builder and lifecycle are
// unit-tested in @unumcp/sandbox and the redaction in security-scan; these
// prove the security properties end-to-end against a real engine (§18.3).
const RUN = process.env.RUN_SANDBOX_DOCKER_TESTS;

/** A project declaring only dependencies the sandbox image provides. */
const PACKAGE_JSON = JSON.stringify({ name: "probe", private: true, devDependencies: { vitest: "^2.1.0" } });

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unumcp-sbx-sec-"));
  for (const [name, content] of Object.entries({ "package.json": PACKAGE_JSON, ...files })) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe.skipIf(!RUN)("sandbox security (P4-10, §18.3; real Docker, opt-in)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("confines the code under test: no network, unprivileged, read-only project and image", async () => {
    const dir = await makeProject({
      "tests/confinement.test.ts": `import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("inside the sandbox", () => {
  it("has no network", async () => {
    await expect(fetch("https://registry.npmjs.org/", { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
  });
  it("is not root", () => {
    expect(process.getuid?.()).not.toBe(0);
  });
  it("cannot modify the project (tests or sources)", () => {
    expect(() => writeFileSync("/sandbox/app/tests/confinement.test.ts", "")).toThrow();
  });
  it("cannot modify the image's dependencies", () => {
    expect(() => writeFileSync("/sandbox/node_modules/injected.js", "")).toThrow();
  });
  it("can still use its scratch tmpfs", () => {
    expect(() => writeFileSync("/tmp/scratch.txt", "ok")).not.toThrow();
  });
});
`,
    });
    dirs.push(dir);

    const result = await runSandbox({ projectDir: dir, testTimeoutMs: 60_000 });

    expect(result.install.ok).toBe(true);
    expect(result.test.log).toMatch(/Tests\s+5 passed \(5\)/);
    expect(result.test.ok).toBe(true);
  }, 900_000);

  it("kills a non-terminating test via the phase timeout and removes its container", async () => {
    const dir = await makeProject({
      "tests/loop.test.ts": `import { it } from "vitest";\nit("spins", () => { while (true) {} });\n`,
    });
    dirs.push(dir);

    // A short test-phase timeout keeps this fast; the infinite loop can never finish.
    const result = await runSandbox({ projectDir: dir, testTimeoutMs: 8_000 });

    expect(result.install.ok).toBe(true);
    expect(result.test.timedOut).toBe(true);
    expect(result.test.ok).toBe(false);

    // The timeout must remove the container itself, not just the docker client:
    // no sandbox container may be left spinning on the infinite loop.
    const leftover = execFileSync("docker", ["ps", "-aq", "--filter", `name=${CONTAINER_NAME_PREFIX}`])
      .toString()
      .trim();
    expect(leftover).toBe("");
  }, 900_000);

  it("a secret printed inside the sandbox does not survive redaction", async () => {
    const token = `ghp_${"a".repeat(36)}`; // GitHub-PAT-shaped, matched by redactSecrets
    const dir = await makeProject({
      "tests/leak.test.ts": `import { expect, it } from "vitest";\nit("leaks", () => {\n  console.log("config token: ${token}");\n  expect(true).toBe(true);\n});\n`,
    });
    dirs.push(dir);

    const result = await runSandbox({ projectDir: dir, testTimeoutMs: 60_000 });

    expect(result.test.ok).toBe(true);
    // The raw secret really did reach the sandbox's output…
    expect(result.test.log).toContain(token);
    // …but the production redaction (what TestingService persists/shows) scrubs it.
    const persisted = redactSecrets(result.test.log);
    expect(persisted).not.toContain(token);
    expect(persisted).toContain("***REDACTED***");
  }, 900_000);
});
