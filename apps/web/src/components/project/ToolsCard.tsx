"use client";

import { Badge, Button, Notice, Panel } from "@/components/ui";
import { api } from "@/lib/api";
import { primaryAction, riskTone } from "@/lib/status";
import { cx, pluralize } from "@/lib/format";
import type { ToolCandidate } from "@/lib/types";
import { useAction, type StageProps } from "./shared";

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
      <ul>
        {tools.map((tool, i) => (
          <li
            key={tool.id}
            className={cx(
              "flex items-start gap-3 px-5 py-3.5",
              i > 0 && "border-t border-line",
              !tool.enabled && "opacity-55",
            )}
          >
            <Toggle
              checked={tool.enabled}
              disabled={locked || action.busy}
              onChange={(next) => action.run(() => api.tools.setEnabled(project.id, tool.id, next))}
            />
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
                  <span className="text-clay">{tool.endpoints[0].endpoint.method}</span>{" "}
                  {tool.endpoints[0].endpoint.path}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

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
          "h-3.5 w-3.5 rounded-full bg-panel shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}
