import { describe, expect, it } from "vitest";
import { buildInstallArgs, buildTestArgs, DEFAULT_LIMITS } from "../src/args";

describe("buildInstallArgs (phase 1)", () => {
  const args = buildInstallArgs("node:22-slim", "/host/project");

  it("runs npm install with the project mounted at /app", () => {
    expect(args.join(" ")).toContain("-v /host/project:/app");
    expect(args.join(" ")).toContain("-w /app");
    expect(args.slice(-4)).toEqual(["npm", "install", "--no-audit", "--no-fund"]);
  });

  it("does NOT disable the network (install needs the registry)", () => {
    expect(args).not.toContain("none");
  });

  it("removes the container after running", () => {
    expect(args).toContain("--rm");
  });
});

describe("buildTestArgs (phase 2)", () => {
  const args = buildTestArgs("node:22-slim", "/host/project", DEFAULT_LIMITS);

  it("disables the network", () => {
    const i = args.indexOf("--network");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("none");
  });

  it("enforces cpu, memory, and pid limits", () => {
    expect(args).toContain("--cpus");
    expect(args).toContain("--memory");
    expect(args).toContain("--pids-limit");
  });

  it("uses a read-only root fs with a writable tmpfs", () => {
    expect(args).toContain("--read-only");
    const i = args.indexOf("--tmpfs");
    expect(args[i + 1]).toBe("/tmp");
  });

  it("runs npm test", () => {
    expect(args.slice(-2)).toEqual(["npm", "test"]);
  });
});
