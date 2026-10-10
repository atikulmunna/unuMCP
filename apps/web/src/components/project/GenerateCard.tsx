"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Notice, Panel, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { primaryAction } from "@/lib/status";
import { cx, pluralize } from "@/lib/format";
import { diffToLines, fileLanguage } from "@/lib/preview";
import type { GenerationArtifact, GenerationLatest, RepairAttempt } from "@/lib/types";
import { DownloadButton, useAction, type StageProps } from "./shared";

export function GenerateCard({
  project,
  generation,
  reload,
}: StageProps & { generation: GenerationLatest | null }) {
  const action = useAction(reload);
  const act = primaryAction(project.status);
  const canGenerate = act === "generate";
  const artifacts = generation?.artifacts ?? [];
  const runId = generation?.run.id ?? null;

  const [selected, setSelected] = useState<{ id: string; path: string } | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [repairs, setRepairs] = useState<RepairAttempt[]>([]);

  // Load repair history whenever the run changes; close any open file too.
  useEffect(() => {
    setSelected(null);
    setCode(null);
    if (!runId) {
      setRepairs([]);
      return;
    }
    let active = true;
    api.generation
      .repairs(project.id)
      .then((r) => active && setRepairs(r))
      .catch(() => active && setRepairs([]));
    return () => {
      active = false;
    };
  }, [runId, project.id]);

  async function openFile(a: GenerationArtifact) {
    setSelected({ id: a.id, path: a.path });
    setCode(null);
    setCodeBusy(true);
    try {
      const res = await api.generation.artifact(project.id, a.id);
      setCode(res.content);
    } catch {
      setCode("// Could not load this file.");
    } finally {
      setCodeBusy(false);
    }
  }

  return (
    <Panel
      eyebrow="Stage 3"
      title="Generation"
      description="A deterministic, typed TypeScript MCP server is produced from the approved plan."
      actions={
        generation && (
          <Badge tone={generation.run.status === "failed" ? "bad" : "ok"}>
            {pluralize(artifacts.length, "file")}
          </Badge>
        )
      }
    >
      {generation?.run.errorMessage && (
        <div className="mb-4">
          <Notice tone="bad" title="Generation failed">
            {generation.run.errorMessage}
          </Notice>
        </div>
      )}

      {artifacts.length > 0 ? (
        <>
          <FileTree artifacts={artifacts} selectedId={selected?.id ?? null} onSelect={openFile} />
          {selected && <CodeViewer path={selected.path} content={code} busy={codeBusy} />}
          <RepairHistory repairs={repairs} />
        </>
      ) : (
        <p className="text-sm text-ink-muted">Nothing generated yet.</p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="font-mono text-2xs text-ink-faint">
          {generation?.run.mcpSdkVersion ? `MCP SDK ${generation.run.mcpSdkVersion}` : "MCP server scaffold"}
        </span>
        <div className="flex gap-2">
          {artifacts.length > 0 && <DownloadButton projectId={project.id} variant="secondary" />}
          {canGenerate && (
            <Button
              variant="primary"
              loading={action.busy}
              onClick={() => action.run(() => api.generation.run(project.id))}
            >
              {generation ? "Re-generate" : "Generate server"}
            </Button>
          )}
        </div>
      </div>
      {action.error && (
        <div className="mt-4">
          <Notice tone="bad">{action.error}</Notice>
        </div>
      )}
    </Panel>
  );
}

const ARTIFACT_DOT: Record<GenerationLatest["artifacts"][number]["artifactType"], string> = {
  source_file: "bg-ink-faint",
  test_file: "bg-run",
  readme: "bg-ok",
  archive: "bg-warn",
};

function FileTree({
  artifacts,
  selectedId,
  onSelect,
}: {
  artifacts: GenerationLatest["artifacts"];
  selectedId: string | null;
  onSelect: (a: GenerationArtifact) => void;
}) {
  return (
    <ul className="max-h-64 space-y-0.5 overflow-auto rounded-md border border-line bg-paper/50 p-2 scroll-slim">
      {artifacts.map((a) => (
        <li key={a.path}>
          <button
            type="button"
            onClick={() => onSelect(a)}
            className={cx(
              "flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left transition-colors hover:bg-panel",
              selectedId === a.id && "bg-panel ring-1 ring-clay/30",
            )}
          >
            <code className="truncate font-mono text-xs text-ink-soft">{a.path}</code>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-2xs text-ink-faint">{a.contentHash.slice(0, 8)}</span>
              <span className={cx("h-1.5 w-1.5 rounded-full", ARTIFACT_DOT[a.artifactType])} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Read-only preview of a single generated file (P4-9, §15.5). */

function CodeViewer({ path, content, busy }: { path: string; content: string | null; busy: boolean }) {
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-paper/60 px-3 py-1.5">
        <code className="truncate font-mono text-2xs text-ink-soft">{path}</code>
        <span className="shrink-0 font-mono text-2xs uppercase tracking-eyebrow text-ink-faint">
          {busy ? <Spinner /> : fileLanguage(path)}
        </span>
      </div>
      <pre className="max-h-80 overflow-auto bg-ink p-3 font-mono text-2xs leading-relaxed text-paper/90 scroll-slim">
        {content ?? ""}
      </pre>
    </div>
  );
}

/** Collapsible repair-loop history with coloured unified diffs (P4-6/P4-9). */

function RepairHistory({ repairs }: { repairs: RepairAttempt[] }) {
  const [open, setOpen] = useState(false);
  if (repairs.length === 0) return null;
  return (
    <div className="mt-4 border-t border-line pt-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-2xs uppercase tracking-eyebrow text-ink-muted hover:text-ink"
      >
        {open ? "▾ Hide" : "▸ Show"} repair history · {pluralize(repairs.length, "attempt")}
      </button>
      {open && (
        <ul className="mt-3 space-y-3">
          {repairs.map((r) => (
            <li key={r.attemptNumber} className="overflow-hidden rounded-md border border-line">
              <div className="flex items-center justify-between gap-3 border-b border-line bg-paper/60 px-3 py-1.5">
                <span className="font-mono text-2xs text-ink-soft">Attempt {r.attemptNumber}</span>
                <Badge tone={r.outcome === "passed" ? "ok" : "bad"}>{r.outcome}</Badge>
              </div>
              <pre className="max-h-72 overflow-auto bg-ink p-3 font-mono text-2xs leading-relaxed scroll-slim">
                {diffToLines(r.diff).map((l, i) => (
                  <div
                    key={i}
                    className={cx(
                      l.tone === "add" && "text-ok",
                      l.tone === "del" && "text-bad",
                      l.tone === "meta" && "text-ink-faint",
                      l.tone === "context" && "text-paper/70",
                    )}
                  >
                    {l.text || " "}
                  </div>
                ))}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
