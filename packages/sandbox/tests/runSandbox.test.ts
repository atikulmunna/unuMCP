import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `docker` is replaced by a fake so the lifecycle runs without Docker.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

interface FakeOptions {
  /** `docker image inspect` finds the image. */
  imagePresent?: boolean;
  /** `docker build` succeeds. */
  buildOk?: boolean;
  /** The test container exits 0 at once, or hangs like a runaway container. */
  test?: "exit0" | "hang";
}

/**
 * Fake `docker`. A hanging `run` only ends when `docker rm --force <name>`
 * removes it (which ends the attached CLI with 137, as the real daemon does):
 * killing the CLI alone does NOT end it.
 */
function fakeDocker({ imagePresent = true, buildOk = true, test = "exit0" }: FakeOptions = {}) {
  const hanging = new Map<string, FakeChild>();
  const calls: string[][] = [];
  vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    }) as FakeChild;
    const exit = (code: number) => setImmediate(() => child.emit("close", code));

    if (args[0] === "image") exit(imagePresent ? 0 : 1);
    else if (args[0] === "build") exit(buildOk ? 0 : 1);
    else if (args[0] === "rm") {
      const target = hanging.get(args[2] ?? "");
      setImmediate(() => {
        target?.emit("close", 137);
        child.emit("close", 0);
      });
    } else if (test === "hang") hanging.set(args[args.indexOf("--name") + 1] ?? "", child);
    else exit(0);
    return child;
  }) as never);
  return calls;
}

const runs = (calls: string[][]) => calls.filter((a) => a[0] === "run");
const nameOf = (args: string[]) => args[args.indexOf("--name") + 1];

let projectDir: string;
let runSandbox: typeof import("../src/runSandbox").runSandbox;

beforeEach(async () => {
  vi.mocked(spawn).mockReset();
  // Fresh module per test: the "image exists" check is memoized per process.
  vi.resetModules();
  ({ runSandbox } = await import("../src/runSandbox"));
  projectDir = await mkdtemp(join(tmpdir(), "unumcp-sbx-unit-"));
  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ dependencies: { zod: "^3.25.0" }, devDependencies: { vitest: "^2.1.0" } }),
  );
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("runSandbox", () => {
  it("runs one test container from the prebuilt image, with no install container", async () => {
    const calls = fakeDocker();
    const result = await runSandbox({ projectDir });

    expect(result.install.ok).toBe(true);
    expect(result.test.ok).toBe(true);
    expect(runs(calls)).toHaveLength(1);
    expect(nameOf(runs(calls)[0]!)).toMatch(/^unumcp-sbx-.+-test$/);
    expect(runs(calls)[0]).toContain("none"); // --network none
    expect(calls.some((a) => a[0] === "build" || a[0] === "rm")).toBe(false);
  });

  it("builds the image on first use when it is missing", async () => {
    const calls = fakeDocker({ imagePresent: false });
    const result = await runSandbox({ projectDir });

    expect(result.install.ok).toBe(true);
    expect(calls.map((a) => a[0])).toEqual(["image", "build", "run"]);
  });

  it("fails preparation (no container) when the image cannot be built", async () => {
    const calls = fakeDocker({ imagePresent: false, buildOk: false });
    const result = await runSandbox({ projectDir });

    expect(result.install.ok).toBe(false);
    expect(result.install.log).toMatch(/Could not build the sandbox image/);
    expect(runs(calls)).toHaveLength(0);
  });

  it("fails preparation when the project declares a dependency the image lacks", async () => {
    await writeFile(join(projectDir, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.0.0" } }));
    const calls = fakeDocker();
    const result = await runSandbox({ projectDir });

    expect(result.install.ok).toBe(false);
    expect(result.install.log).toMatch(/does not provide: left-pad@1\.0\.0/);
    expect(runs(calls)).toHaveLength(0);
  });

  it("force-removes the test container by name when the phase times out", async () => {
    const calls = fakeDocker({ test: "hang" });
    const result = await runSandbox({ projectDir, testTimeoutMs: 20 });

    expect(result.test).toMatchObject({ ok: false, timedOut: true });
    expect(calls).toContainEqual(["rm", "--force", nameOf(runs(calls)[0]!)]);
  });

  it("force-removes the running container when the run is cancelled", async () => {
    const calls = fakeDocker({ test: "hang" });
    const controller = new AbortController();
    const pending = runSandbox({ projectDir, signal: controller.signal });

    // Cancel only once the test container is actually running (preparation is async).
    await vi.waitFor(() => expect(runs(calls)).toHaveLength(1));
    controller.abort();
    const result = await pending;

    expect(result.test).toMatchObject({ ok: false, timedOut: false });
    expect(calls).toContainEqual(["rm", "--force", nameOf(runs(calls)[0]!)]);
  });
});
