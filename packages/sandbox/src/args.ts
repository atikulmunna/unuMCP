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

/**
 * 1 GB: typechecking a server costs about 150 MB plus 0.45 MB per tool (913
 * GitHub tools peak near 480 MB), and the tests run alongside the compiler's
 * leftovers. Runs are serialized, so a small host still affords it.
 */
export const DEFAULT_LIMITS: SandboxLimits = {
  cpus: "1",
  memory: "1g",
  pids: 256,
};

/**
 * Node's heap for the container, in MB: 75% of its memory limit. Without it
 * V8 picks a much smaller default inside the container and a large server's
 * typecheck dies at about 250 MB with memory to spare.
 */
export function heapMegabytes(memory: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i.exec(memory.trim());
  if (!match) return 384;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const megabytes = unit === "g" ? amount * 1024 : unit === "k" ? amount / 1024 : amount;
  return Math.max(128, Math.floor(megabytes * 0.75));
}

/**
 * Every sandbox container is named with this prefix, so a timed-out or
 * cancelled one can be force-removed through the daemon (killing the `docker`
 * CLI alone leaves the container running) and leftovers are easy to find.
 */
export const CONTAINER_NAME_PREFIX = "unumcp-sbx-";

/** The unprivileged `node` user of the official Node images. */
const SANDBOX_USER = "1000:1000";

/**
 * Typecheck, then test. Vitest only strips types, so without the `tsc` step a
 * project with type errors (say, a model's repair) could still pass. A failed
 * typecheck stops before the tests and leaves no passing summary, so the run
 * counts as failed and the compiler errors are what repair sees. Projects
 * without a tsconfig (ad-hoc fixtures) skip straight to the tests.
 *
 * Vitest runs one worker without per-file isolation: the container has one
 * CPU (Docker doesn't hide the host's core count, so Vitest would otherwise
 * spawn a worker per host core), and re-creating a module graph per file made
 * a 913-tool server's suite five times slower. Files run one at a time and
 * every test resets its own `fetch` stub, so sharing the context is safe.
 */
const TEST_COMMAND = [
  `if [ -f tsconfig.json ]; then node ${SANDBOX_ROOT}/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json || exit 1; fi`,
  `exec node ${SANDBOX_ROOT}/node_modules/vitest/vitest.mjs run --no-cache --maxWorkers=1 --minWorkers=1 --no-isolate`,
].join("; ");

/**
 * The test run: a typecheck, then the project's own Vitest suite, inside the
 * prebuilt sandbox image, whose dependencies are already installed, so nothing
 * is downloaded and no project-controlled script (`npm test`, lifecycle hooks)
 * ever runs.
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
    "-e",
    `NODE_OPTIONS=--max-old-space-size=${heapMegabytes(limits.memory)}`,
    "-v",
    `${projectDir}:${SANDBOX_APP_DIR}:ro`,
    "-w",
    SANDBOX_APP_DIR,
    image,
    "sh",
    "-c",
    TEST_COMMAND,
  ];
}
