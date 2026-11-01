import { toolGroup } from "@unumcp/analysis";
import type { GeneratedFile, GenerateOptions, NormalizedOptions } from "./types";
import { envExampleFile, packageJsonFile, readmeFile, tsconfigFile } from "./project-files";
import { apiClientFile, apiErrorFile, envConfigFile, indexFile, policyFile, serverFile } from "./runtime-files";
import { schemaFile, toolFile } from "./tool-files";
import { harnessFile, serverTestFile, testFile } from "./test-files";

/** The MCP SDK every generated server pins (the sandbox image bakes in the same one). */
export const MCP_SDK_VERSION = "1.32.1";
const DEFAULT_ZOD_VERSION = "^4.6.7";

/**
 * Deterministically generate a complete TypeScript MCP server project from a
 * set of tool definitions (FR-018, §12.4). Pure: same options → same files.
 *
 * The tests it emits are contract tests: each drives a tool through a real MCP
 * client (in-memory transport) with the upstream API stubbed, and asserts the
 * exact HTTP request the spec defines (see `contract.ts`).
 */
export function generateProject(options: GenerateOptions): GeneratedFile[] {
  const opts = normalize(options);
  const files: GeneratedFile[] = [
    packageJsonFile(opts),
    tsconfigFile(),
    envConfigFile(opts),
    apiErrorFile(),
    apiClientFile(opts.auth),
    policyFile(),
    serverFile(opts),
    indexFile(),
    readmeFile(opts),
    envExampleFile(opts),
    harnessFile(),
    serverTestFile(opts),
  ];
  for (const tool of opts.tools) {
    files.push(schemaFile(tool));
    files.push(toolFile(tool));
    files.push(testFile(tool, opts.auth));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Tool names become TypeScript identifiers and file names. */
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]*$/;
/** Toolset names are typed into MCP_TOOLSETS. */
const SAFE_TOOLSET = /^[a-z0-9_]+$/;

/**
 * Refuse input that could change the generated project's meaning. Callers
 * validate both already; this backstop covers data stored before they did.
 */
function assertSafe(o: GenerateOptions): void {
  const unsafe = o.tools.find((t) => !SAFE_TOOL_NAME.test(t.name));
  if (unsafe) throw new Error(`Tool name ${JSON.stringify(unsafe.name)} is not a snake_case identifier.`);
  const badToolset = o.tools.find((t) => t.toolset !== undefined && !SAFE_TOOLSET.test(t.toolset));
  if (badToolset) throw new Error(`Toolset ${JSON.stringify(badToolset.toolset)} is not a snake_case name.`);
  // The base URL goes into .env.example and the README as plain text.
  if (/[\s\p{Cc}]/u.test(o.baseUrl)) throw new Error("The base URL contains spaces or line breaks.");
}

function normalize(o: GenerateOptions): NormalizedOptions {
  assertSafe(o);
  return {
    serverName: o.serverName,
    displayName: o.displayName ?? o.serverName,
    baseUrl: o.baseUrl,
    baseUrlEnvVar: o.baseUrlEnvVar ?? "API_BASE_URL",
    tools: o.tools.map((t) => ({ ...t, toolset: t.toolset ?? toolGroup({ path: t.pathTemplate }) })),
    auth: o.auth,
    mcpSdkVersion: o.mcpSdkVersion ?? MCP_SDK_VERSION,
    zodVersion: o.zodVersion ?? DEFAULT_ZOD_VERSION,
  };
}
