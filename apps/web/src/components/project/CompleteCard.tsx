"use client";

import { useState } from "react";
import { Badge, Button, Notice, Panel } from "@/components/ui";
import { api } from "@/lib/api";
import { primaryAction, statusMeta } from "@/lib/status";
import { DownloadButton, useAction, type StageProps } from "./shared";

export function CompleteCard({ project, reload }: StageProps) {
  const action = useAction(reload);
  const [warnings, setWarnings] = useState<string[]>([]);
  const act = primaryAction(project.status);
  const done = project.status === "COMPLETED" || project.status === "COMPLETED_WITH_WARNINGS";
  const withWarnings = project.status === "COMPLETED_WITH_WARNINGS";

  return (
    <Panel
      eyebrow="Stage 5"
      title="Completion"
      description="Finalize the build and download the packaged server as a ZIP archive."
      actions={done && <Badge tone={withWarnings ? "warn" : "ok"}>{statusMeta(project.status).label}</Badge>}
    >
      {done ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-ok/25 bg-ok-wash px-4 py-3">
            <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-ok text-paper">
              <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <p className="text-sm text-ink-soft">
              Your MCP server is built and verified. The archive contains source, tests, a README,
              and an <code className="font-mono text-xs">.env.example</code>, and no secrets.
            </p>
          </div>
          {warnings.length > 0 && (
            <Notice tone="warn" title="Completed with warnings">
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
          <DownloadButton projectId={project.id} variant="primary" />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-ink-muted">
            {act === "complete"
              ? "All tests pass. Finalize to lock the build."
              : "Completion unlocks once the sandbox tests pass."}
          </p>
          <Button
            variant="primary"
            loading={action.busy}
            disabled={act !== "complete"}
            onClick={() =>
              action.run(async () => {
                const res = await api.complete(project.id);
                setWarnings(res.warnings);
              })
            }
          >
            Complete build
          </Button>
        </div>
      )}
      {action.error && (
        <div className="mt-4">
          <Notice tone="bad">{action.error}</Notice>
        </div>
      )}
    </Panel>
  );
}
