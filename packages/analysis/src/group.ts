/**
 * The group a tool belongs to: its endpoint's OpenAPI tag, or else the first
 * literal path segment ("/repos/{owner}/issues" is in "repos"). It is
 * lowercase snake_case, so the same name works as a toolset that a generated
 * server's MCP_TOOLSETS accepts.
 */
export function toolGroup(endpoint: { tag?: string | null; path: string }): string {
  const firstSegment = endpoint.path.split("/").find((s) => s && !s.startsWith("{"));
  const source = endpoint.tag?.trim() || firstSegment || "";
  const slug = source
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "other";
}
