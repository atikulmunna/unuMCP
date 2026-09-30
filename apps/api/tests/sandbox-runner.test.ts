import { describe, expect, it } from "vitest";
import type { SandboxResult } from "@unumcp/sandbox";
import {
  sandboxConcurrencyFromEnv,
  withConcurrencyLimit,
  type SandboxRunner,
} from "../src/testing/sandbox-runner";

const ok: SandboxResult = {
  install: { ok: true, exitCode: 0, log: "", timedOut: false },
  test: { ok: true, exitCode: 0, log: " Tests  1 passed (1)\n", timedOut: false },
};

/** A runner whose runs stay open until the test finishes them, tracking overlap. */
function gatedRunner() {
  let active = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  const runner: SandboxRunner = {
    run: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active--;
      return ok;
    },
  };
  return { runner, gates, peak: () => peak };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("withConcurrencyLimit (sandbox runs)", () => {
  it("runs one sandbox at a time by default and tells queued runs they are waiting", async () => {
    const { runner, gates, peak } = gatedRunner();
    const limited = withConcurrencyLimit(runner, sandboxConcurrencyFromEnv({}));

    const logs: string[] = [];
    const first = limited.run("/a");
    const second = limited.run("/b", { onLog: (_phase, chunk) => logs.push(chunk) });
    await tick();
    expect(gates).toHaveLength(1); // the second run has not started
    expect(logs.join("")).toMatch(/Waiting for a free sandbox slot/);

    gates[0]!();
    await first;
    await tick();
    gates[1]!();
    await second;
    expect(peak()).toBe(1);
  });

  it("never starts a run cancelled while it was queued", async () => {
    const { runner, gates } = gatedRunner();
    const limited = withConcurrencyLimit(runner, 1);
    const first = limited.run("/a");
    const controller = new AbortController();
    const queued = limited.run("/b", { signal: controller.signal });

    controller.abort();
    const result = await queued;
    expect(result.install.ok).toBe(false);
    expect(result.install.log).toMatch(/Cancelled while waiting/);

    await tick();
    gates[0]!();
    await first;
    expect(gates).toHaveLength(1); // the cancelled run never reached the runner
  });

  it("reads SANDBOX_CONCURRENCY, falling back to 1", () => {
    expect(sandboxConcurrencyFromEnv({})).toBe(1);
    expect(sandboxConcurrencyFromEnv({ SANDBOX_CONCURRENCY: "3" })).toBe(3);
    expect(sandboxConcurrencyFromEnv({ SANDBOX_CONCURRENCY: "0" })).toBe(1);
    expect(sandboxConcurrencyFromEnv({ SANDBOX_CONCURRENCY: "nope" })).toBe(1);
  });
});
