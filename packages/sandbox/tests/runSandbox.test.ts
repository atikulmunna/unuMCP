import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `docker` is replaced by a fake so the timeout/cancel path runs without Docker.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { CONTAINER_NAME_PREFIX } from "../src/args";
import { runSandbox } from "../src/runSandbox";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

type Behaviour = "exit0" | "hang";

/**
 * Fake `docker`: `run` either exits 0 at once or hangs like a runaway container
 * until `docker rm --force <name>` removes it (which ends the attached CLI with
 * 137, as the real daemon does). Killing the CLI alone does NOT end the run.
 */
function fakeDocker(phases: { install: Behaviour; test: Behaviour }) {
  const hanging = new Map<string, FakeChild>();
  const calls: string[][] = [];
  vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    }) as FakeChild;

    if (args[0] === "rm") {
      const target = hanging.get(args[2] ?? "");
      setImmediate(() => {
        target?.emit("close", 137);
        child.emit("close", 0);
      });
    } else {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const phase = args.includes("install") ? "install" : "test";
      if (phases[phase] === "hang") hanging.set(name, child);
      else setImmediate(() => child.emit("close", 0));
    }
    return child;
  }) as never);
  return calls;
}

const nameOf = (args: string[]) => args[args.indexOf("--name") + 1];

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("runSandbox container lifecycle", () => {
  it("gives each phase its own prefixed container name", async () => {
    const calls = fakeDocker({ install: "exit0", test: "exit0" });
    const result = await runSandbox({ projectDir: "/p" });

    expect(result.install.ok).toBe(true);
    const [install, test] = calls;
    expect(nameOf(install!)).toMatch(new RegExp(`^${CONTAINER_NAME_PREFIX}.+-install$`));
    expect(nameOf(test!)).toMatch(new RegExp(`^${CONTAINER_NAME_PREFIX}.+-test$`));
    expect(calls.some((a) => a[0] === "rm")).toBe(false);
  });

  it("force-removes the test container by name when the phase times out", async () => {
    const calls = fakeDocker({ install: "exit0", test: "hang" });
    const result = await runSandbox({ projectDir: "/p", testTimeoutMs: 20 });

    expect(result.test).toMatchObject({ ok: false, timedOut: true });
    const testName = nameOf(calls[1]!);
    expect(calls).toContainEqual(["rm", "--force", testName]);
  });

  it("force-removes the running container when the run is cancelled", async () => {
    const calls = fakeDocker({ install: "hang", test: "exit0" });
    const controller = new AbortController();
    const pending = runSandbox({ projectDir: "/p", signal: controller.signal });

    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const result = await pending;

    expect(result.install).toMatchObject({ ok: false, timedOut: false });
    expect(result.test.log).toBe("skipped (install failed)");
    expect(calls).toContainEqual(["rm", "--force", nameOf(calls[0]!)]);
  });
});
