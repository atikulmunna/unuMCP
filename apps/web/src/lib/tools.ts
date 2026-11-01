// Pure helpers for the tool plan, kept testable without React.

interface GroupableTool {
  name: string;
  description: string;
  group: string;
  enabled: boolean;
  riskLevel: string;
  endpoints: { endpoint: { path: string } }[];
}

export interface ToolGroup<T> {
  name: string;
  tools: T[];
  enabled: number;
  total: number;
  /** Off tools that turning the group on would enable: high and critical ones stay off. */
  canTurnOn: number;
}

const HIGH_RISK = new Set(["high", "critical"]);

/** Plans this long are shown by group, with search; shorter ones stay a flat list. */
export const GROUPED_FROM = 20;

/** Agents choose less reliably from long lists, so the plan suggests trimming past this. */
export const LONG_LIST = 40;

export function showGrouped(tools: GroupableTool[]): boolean {
  return tools.length >= GROUPED_FROM && new Set(tools.map((t) => t.group)).size > 1;
}

/** Whether a tool matches a search, by name, group, description or path (case-insensitive). */
export function matches(tool: GroupableTool, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const path = tool.endpoints[0]?.endpoint.path ?? "";
  return [tool.name, tool.group, tool.description, path].some((text) => text.toLowerCase().includes(q));
}

/**
 * The tools grouped, in name order, keeping only those matching `query`. Each
 * group's counts cover all its tools, so a search never hides what is on.
 */
export function groupTools<T extends GroupableTool>(tools: T[], query = ""): ToolGroup<T>[] {
  const groups = new Map<string, ToolGroup<T>>();
  for (const tool of tools) {
    const group = groups.get(tool.group) ?? { name: tool.group, tools: [], enabled: 0, total: 0, canTurnOn: 0 };
    group.total += 1;
    if (tool.enabled) group.enabled += 1;
    else if (!HIGH_RISK.has(tool.riskLevel)) group.canTurnOn += 1;
    if (matches(tool, query)) group.tools.push(tool);
    groups.set(tool.group, group);
  }
  return [...groups.values()].filter((g) => g.tools.length > 0).sort((a, b) => a.name.localeCompare(b.name));
}
