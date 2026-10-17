import type { GeneratedFile, GenerateOptions, NormalizedOptions } from "./types";
import { envExampleFile, packageJsonFile, readmeFile, tsconfigFile } from "./project-files";
import { apiClientFile, apiErrorFile, envConfigFile, indexFile, policyFile, serverFile } from "./runtime-files";
import { schemaFile, toolFile } from "./tool-files";
import { harnessFile, serverTestFile, testFile } from "./test-files";

/** The MCP SDK every generated server pins (the sandbox image bakes in the same one). */
export const MCP_SDK_VERSION = "1.32.1";
const DEFAULT_ZOD_VERSION = "^3.25.0";

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

function normalize(o: GenerateOptions): NormalizedOptions {
  return {
    serverName: o.serverName,
    displayName: o.displayName ?? o.serverName,
    baseUrl: o.baseUrl,
    baseUrlEnvVar: o.baseUrlEnvVar ?? "API_BASE_URL",
    tools: o.tools,
    auth: o.auth,
    mcpSdkVersion: o.mcpSdkVersion ?? MCP_SDK_VERSION,
    zodVersion: o.zodVersion ?? DEFAULT_ZOD_VERSION,
  };
}
