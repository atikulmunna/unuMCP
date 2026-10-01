import { describe, expect, it } from "vitest";
import { buildTestArgs, DEFAULT_LIMITS, heapMegabytes } from "../src/args";

describe("buildTestArgs", () => {
  const args = buildTestArgs("unumcp-sandbox:abc", "/host/project", "unumcp-sbx-1-test", DEFAULT_LIMITS);
  const valueOf = (flag: string) => args[args.indexOf(flag) + 1];

  it("disables the network", () => {
    expect(valueOf("--network")).toBe("none");
  });

  it("enforces cpu, memory (no swap), and pid limits", () => {
    expect(valueOf("--cpus")).toBe(DEFAULT_LIMITS.cpus);
    expect(valueOf("--memory")).toBe(DEFAULT_LIMITS.memory);
    expect(valueOf("--memory-swap")).toBe(DEFAULT_LIMITS.memory);
    expect(valueOf("--pids-limit")).toBe(String(DEFAULT_LIMITS.pids));
  });

  it("sizes Node's heap to the container's memory limit", () => {
    expect(args).toContain("NODE_OPTIONS=--max-old-space-size=768"); // 75% of the default 1g
    expect(heapMegabytes("512m")).toBe(384);
    expect(heapMegabytes("2g")).toBe(1536);
    expect(heapMegabytes("2048M")).toBe(1536);
  });

  it("uses a read-only root fs with a small writable tmpfs", () => {
    expect(args).toContain("--read-only");
    expect(valueOf("--tmpfs")).toMatch(/^\/tmp:.*nosuid.*size=/);
  });

  it("drops all capabilities, forbids privilege escalation, and runs unprivileged", () => {
    expect(valueOf("--cap-drop")).toBe("ALL");
    expect(valueOf("--security-opt")).toBe("no-new-privileges");
    expect(valueOf("--user")).toBe("1000:1000");
  });

  it("mounts the project read-only under the image's dependency root", () => {
    expect(valueOf("-v")).toBe("/host/project:/sandbox/app:ro");
    expect(valueOf("-w")).toBe("/sandbox/app");
  });

  it("names the container so a timeout or cancel can force-remove it", () => {
    expect(valueOf("--name")).toBe("unumcp-sbx-1-test");
    expect(args).toContain("--rm");
  });

  it("typechecks, then runs the image's own Vitest, never a project npm script", () => {
    const [image, shell, flag, command] = args.slice(args.indexOf("unumcp-sandbox:abc"));
    expect([image, shell, flag]).toEqual(["unumcp-sandbox:abc", "sh", "-c"]);
    expect(command).toBe(
      "if [ -f tsconfig.json ]; then node /sandbox/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json || exit 1; fi; " +
        "exec node /sandbox/node_modules/vitest/vitest.mjs run --no-cache --maxWorkers=1 --minWorkers=1 --no-isolate",
    );
    expect(args.join(" ")).not.toMatch(/\bnpm\b/);
  });
});
