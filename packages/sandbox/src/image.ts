import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The dependency set every generated MCP server declares (codegen's
 * `package.json` template). Baked into the sandbox image so the test run needs
 * no network and no `npm install` of project-controlled manifests at all. A
 * drift test keeps this in lockstep with the codegen template; a project that
 * declares anything else fails the dependency check before any container runs.
 */
export const SANDBOX_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@modelcontextprotocol/sdk": "1.29.0",
  zod: "^3.25.0",
  "@types/node": "^22.0.0",
  tsx: "^4.19.0",
  typescript: "^5.6.0",
  vitest: "^2.1.0",
};

/** Where the image keeps its dependencies; the project is mounted beneath it. */
export const SANDBOX_ROOT = "/sandbox";
export const SANDBOX_APP_DIR = `${SANDBOX_ROOT}/app`;

const IMAGE_REPOSITORY = "unumcp-sandbox";

const DOCKERFILE = `FROM node:22-slim
WORKDIR ${SANDBOX_ROOT}
COPY package.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force
`;

const MANIFEST = `${JSON.stringify(
  { name: "unumcp-sandbox-deps", private: true, dependencies: SANDBOX_DEPENDENCIES },
  null,
  2,
)}\n`;

/**
 * The sandbox image tag: a content hash of its Dockerfile and dependency
 * manifest, so any change to either yields a new tag (and a rebuild) instead of
 * silently reusing a stale image.
 */
export const SANDBOX_IMAGE = `${IMAGE_REPOSITORY}:${createHash("sha256")
  .update(DOCKERFILE)
  .update(MANIFEST)
  .digest("hex")
  .slice(0, 12)}`;

/** A first-time image build downloads Node + the dependency set; generous but bounded. */
const BUILD_TIMEOUT_MS = 15 * 60_000;

/** Run a docker CLI command to completion (or until `timeoutMs`), streaming its output. */
function docker(
  args: string[],
  onChunk?: (chunk: string) => void,
  timeoutMs?: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true });
    let output = "";
    const append = (d: Buffer) => {
      const s = d.toString();
      output += s;
      onChunk?.(s);
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            output += `\n[timed out after ${timeoutMs} ms]\n`;
            child.kill("SIGKILL");
          }, timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Build the sandbox image from the in-code Dockerfile + manifest (needs network). */
export async function buildSandboxImage(
  onChunk?: (chunk: string) => void,
): Promise<{ ok: boolean; log: string }> {
  const context = await mkdtemp(join(tmpdir(), "unumcp-sbx-image-"));
  try {
    await writeFile(join(context, "Dockerfile"), DOCKERFILE);
    await writeFile(join(context, "package.json"), MANIFEST);
    const { code, output } = await docker(
      ["build", "-t", SANDBOX_IMAGE, context],
      onChunk,
      BUILD_TIMEOUT_MS,
    );
    return { ok: code === 0, log: output };
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

let ensured: Promise<{ ok: boolean; log: string }> | null = null;

/**
 * Make sure the sandbox image exists, building it on first use. Memoized per
 * process so concurrent first runs share one build; a failed build is not
 * cached, so the next run retries.
 */
export function ensureSandboxImage(
  onChunk?: (chunk: string) => void,
): Promise<{ ok: boolean; log: string }> {
  ensured ??= (async () => {
    const inspect = await docker(["image", "inspect", "--format", "{{.Id}}", SANDBOX_IMAGE]);
    if (inspect.code === 0) return { ok: true, log: "" };
    onChunk?.(`Building sandbox image ${SANDBOX_IMAGE} (first run only)...\n`);
    return buildSandboxImage(onChunk);
  })().then((result) => {
    if (!result.ok) ensured = null;
    return result;
  });
  return ensured;
}

/**
 * Dependencies a project declares that the image does not provide (by name and
 * exact version spec). Empty means the prebuilt image can run its tests.
 */
export function missingDependencies(packageJson: string): string[] {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(packageJson);
  } catch {
    return ["package.json (not valid JSON)"];
  }
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.entries(declared)
    .filter(([name, spec]) => SANDBOX_DEPENDENCIES[name] !== spec)
    .map(([name, spec]) => `${name}@${spec}`);
}
