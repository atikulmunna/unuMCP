import { scanGeneratedProject, type ScanFile, type ScanResult } from "@unumcp/security-scan";

/** Base URL codegen falls back to when the spec declares no server. */
export const DEFAULT_BASE_URL = "https://api.example.com";

/**
 * The static security gate (P6-3, §16.3) applied to every file the platform
 * persists: deterministic codegen output and every LLM repair alike. The spec's
 * own API host is the only outbound host the code may reference.
 */
export function scanForPackaging(files: ScanFile[], baseUrl: string): ScanResult {
  return scanGeneratedProject(files, { allowedHosts: [hostOf(baseUrl)] });
}

/** Hostname (no port) of a base URL; "" if it can't be parsed. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}
