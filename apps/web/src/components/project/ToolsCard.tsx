"use client";

import { useState } from "react";
import { Badge, Button, Input, Notice, Panel } from "@/components/ui";
import { api } from "@/lib/api";
import { primaryAction, riskTone } from "@/lib/status";
import { cx, pluralize } from "@/lib/format";
import { groupTools, LONG_LIST, showGrouped } from "@/lib/tools";
import type { ToolCandidate } from "@/lib/types";
import { useAction, type StageProps } from "./shared";
import { UsabilityPanel } from "./UsabilityPanel";

export function ToolsCard({
  project,
  tools,
  reload,
}: StageProps & { tools: ToolCandidate[] }) {
  const action = useAction(reload);
  const act = primaryAction(project.status);
  const proposed = tools.length > 0;
  const locked = act !== "approve-tools"; // can only edit while reviewing
  const enabledCount = tools.filter((t) => t.enabled).length;

  if (!proposed) {
    return (
      <Panel
        eyebrow="Stage 2"
        title="Tool plan"
        description="Propose a set of MCP tools from the analyzed endpoints, then review them."
      >
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-ink-muted">No tools proposed yet.</p>
          <Button
            variant="primary"
            loading={action.busy}
            disabled={act !== "propose-tools"}
            onClick={() => action.run(() => api.tools.propose(project.id))}
          >
            Propose tools
          </Button>
        </div>
        {action.error && (
          <div className="mt-4">
            <Notice tone="bad">{action.error}</Notice>
          </div>
        )}
      </Panel>
    );
  }

  const row = (tool: ToolCandidate, first: boolean) => (
    <ToolRow
      key={tool.id}
      tool={tool}
      first={first}
      disabled={locked || action.busy}
      onToggle={(next) => action.run(() => api.tools.setEnabled(project.id, tool.id, next))}
    />
  );

  return (
    <Panel
      eyebrow="Stage 2"
      title="Tool plan"
      description={
        locked
          ? "The approved set of tools for this server."
          : "Toggle the tools you want to expose, then approve the plan."
      }
      actions={
        <span className="font-mono text-2xs text-ink-faint">
          {pluralize(enabledCount, "tool")} enabled
        </span>
      }
      bodyClassName="p-0"
    >
      {showGrouped(tools) ? (
        <GroupedTools
          tools={tools}
          locked={locked}
          busy={action.busy}
          enabledCount={enabledCount}
          row={row}
          onToggleGroup={(group, enabled) => action.run(() => api.tools.setGroup(project.id, group, enabled))}
        />
      ) : (
        <ul>{tools.map((tool, i) => row(tool, i === 0))}</ul>
      )}

      <UsabilityPanel project={project} reload={reload} />

      {!locked && (
        <div className="flex items-center justify-between gap-4 border-t border-line px-5 py-4">
          <p className="text-xs text-ink-muted">
            Approving locks the plan and lets generation begin.
          </p>
          <Button
            variant="primary"
            loading={action.busy}
            disabled={enabledCount === 0}
            onClick={() => action.run(() => api.tools.approve(project.id))}
          >
            Approve {pluralize(enabledCount, "tool")}
          </Button>
        </div>
      )}
      {action.error && (
        <div className="px-5 pb-4">
          <Notice tone="bad">{action.error}</Notice>
        </div>
      )}
    </Panel>
  );
}

/**
 * A long plan, by group (the endpoints' tags): a search across all tools, and
 * per group its count, a way to turn it on or off, and its tools when opened.
 */
function GroupedTools({
  tools,
  locked,
  busy,
  enabledCount,
  row,
  onToggleGroup,
}: {
  tools: ToolCandidate[];
  locked: boolean;
  busy: boolean;
  enabledCount: number;
  row: (tool: ToolCandidate, first: boolean) => React.ReactNode;
  onToggleGroup: (group: string, enabled: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const groups = groupTools(tools, query);
  const searching = query.trim().length > 0;
  const toggleOpen = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div>
      <div className="border-b border-line px-5 py-3">
        <Input
          type="search"
          aria-label="Search tools"
          placeholder={`Search ${tools.length} tools by name, group, description or path`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!locked && enabledCount > LONG_LIST && (
          <p className="mt-2 text-xs text-ink-muted">
            {enabledCount} tools are on. Agents choose less reliably from a long list, so keep only the
            groups this server needs.
          </p>
        )}
      </div>
      {groups.length === 0 && <p className="px-5 py-4 text-sm text-ink-muted">No tools match that search.</p>}
      <ul>
        {groups.map((group, i) => {
          const expanded = searching || open.has(group.name);
          return (
            <li key={group.name} className={cx(i > 0 && "border-t border-line")}>
              <div className="flex flex-wrap items-center gap-2 px-5 py-3">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleOpen(group.name)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span aria-hidden className="w-3 font-mono text-xs text-ink-faint">
                    {expanded ? "▾" : "▸"}
                  </span>
                  <code className="font-mono text-sm font-medium text-ink">{group.name}</code>
                  <span className="font-mono text-2xs text-ink-faint">
                    {group.enabled} of {group.total} on
                  </span>
                </button>
                {!locked && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || group.canTurnOn === 0}
                      title="Turns on its low and medium risk tools. High and critical ones stay off until you turn them on."
                      onClick={() => onToggleGroup(group.name, true)}
                    >
                      Turn on
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || group.enabled === 0}
                      onClick={() => onToggleGroup(group.name, false)}
                    >
                      Turn off
                    </Button>
                  </div>
                )}
              </div>
              {expanded && (
                <ul className="border-t border-line">{group.tools.map((tool, j) => row(tool, j === 0))}</ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ToolRow({
  tool,
  first,
  disabled,
  onToggle,
}: {
  tool: ToolCandidate;
  first: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <li className={cx("flex items-start gap-3 px-5 py-3.5", !first && "border-t border-line", !tool.enabled && "opacity-55")}>
      <Toggle checked={tool.enabled} disabled={disabled} onChange={onToggle} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm font-medium text-ink">{tool.name}</code>
          <Badge tone={riskTone(tool.riskLevel)} dot={false}>
            {tool.riskLevel}
          </Badge>
          {tool.approved && <Badge tone="ok">approved</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-ink-muted">{tool.description}</p>
        {tool.endpoints[0] && (
          <p className="mt-1 font-mono text-2xs text-ink-faint">
            <span className="text-clay">{tool.endpoints[0].endpoint.method}</span> {tool.endpoints[0].endpoint.path}
          </p>
        )}
      </div>
    </li>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
        checked ? "border-ink bg-ink" : "border-line-strong bg-paper",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        className={cx(
          "h-3.5 w-3.5 rounded-full bg-panel shadow-xs transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}
