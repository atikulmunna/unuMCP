/**
 * Pure builder for the sandbox `docker run` argument vector (§9.8.0). Kept
 * side-effect-free so it can be unit-tested without Docker.
 */
import { SANDBOX_APP_DIR, SANDBOX_ROOT } from "./image";

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

/**
 * Every sandbox container is named with this prefix, so a timed-out or
 * cancelled one can be force-removed through the daemon (killing the `docker`
 * CLI alone leaves the container running) and leftovers are easy to find.
 */
export const CONTAINER_NAME_PREFIX = "unumcp-sbx-";

/** The unprivileged `node` user of the official Node images. */
const SANDBOX_USER = "1000:1000";

/**
 * The test run: the project's own Vitest suite inside the prebuilt sandbox
 * image, whose dependencies are already installed, so nothing is downloaded
 * and no project-controlled script (`npm test`, lifecycle hooks) ever runs.
 *
 * Locked down: no network (NFR-002); CPU/memory/pid caps with swap disabled;
 * read-only root filesystem with a small `nosuid,nodev` tmpfs at `/tmp`; all
 * Linux capabilities dropped; no privilege escalation; an unprivileged user;
 * and the project mounted read-only, so the code under test can't modify its
 * own tests or sources. `--no-cache` keeps Vitest from writing into the mount.
 */
export function buildTestArgs(
  image: string,
  projectDir: string,
  name: string,
  limits: SandboxLimits = DEFAULT_LIMITS,
): string[] {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--cpus",
    limits.cpus,
    "--memory",
    limits.memory,
    "--memory-swap",
    limits.memory,
    "--pids-limit",
    String(limits.pids),
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    SANDBOX_USER,
    "-e",
    "HOME=/tmp",
    "-v",
    `${projectDir}:${SANDBOX_APP_DIR}:ro`,
    "-w",
    SANDBOX_APP_DIR,
    image,
    "node",
    `${SANDBOX_ROOT}/node_modules/vitest/vitest.mjs`,
    "run",
    "--no-cache",
  ];
}
