/**
 * Pure builders for the two-phase sandbox `docker run` argument vectors
 * (§9.8.0). Kept side-effect-free so they can be unit-tested without Docker.
 */

export interface SandboxLimits {
  cpus: string;
  memory: string;
  pids: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  cpus: "1",
  memory: "512m",
  pids: 256,
};

export const DEFAULT_IMAGE = "node:22-slim";

/**
 * Phase 1 — dependency install. Network is permitted (in production it is
 * restricted to an internal allowlisted registry mirror; for the spike it
 * reaches the public registry). The container is removed after running.
 */
export function buildInstallArgs(image: string, projectDir: string): string[] {
  return [
    "run",
    "--rm",
    "-v",
    `${projectDir}:/app`,
    "-w",
    "/app",
    image,
    "npm",
    "install",
    "--no-audit",
    "--no-fund",
  ];
}

/**
 * Phase 2 — test execution. Network fully disabled (NFR-002); CPU/memory/pid
 * limits enforced; root filesystem read-only with a writable tmpfs.
 */
export function buildTestArgs(
  image: string,
  projectDir: string,
  limits: SandboxLimits = DEFAULT_LIMITS,
): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--cpus",
    limits.cpus,
    "--memory",
    limits.memory,
    "--pids-limit",
    String(limits.pids),
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${projectDir}:/app`,
    "-w",
    "/app",
    image,
    "npm",
    "test",
  ];
}
