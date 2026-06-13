"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Field, Notice, Panel, Spinner, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { primaryAction, riskTone, statusMeta } from "@/lib/status";
import { cx, pluralize, saveBlob } from "@/lib/format";
import { diffToLines, fileLanguage } from "@/lib/preview";
import type {
  ApiSpec,
  GenerationArtifact,
  GenerationLatest,
  Project,
  RepairAttempt,
  TestResult,
  ToolCandidate,
} from "@/lib/types";

interface StageProps {
  project: Project;
  reload: () => Promise<void>;
}

function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      after?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

/* ── 1 · Specification ──────────────────────────────────────────────────── */

export function SpecCard({ project, spec, reload }: StageProps & { spec: ApiSpec | null }) {
  const action = useAction(reload);
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState("openapi.json");
  const needsUpload = primaryAction(project.status) === "upload-spec";
  const valid = spec?.validationStatus === "valid";

  async function onFile(file: File) {
    setFilename(file.name);
    setContent(await file.text());
  }

  return (
    <Panel
      eyebrow="Stage 1"
      title="Specification"
      description="The OpenAPI document is parsed, validated, and analyzed for endpoints and auth."
      actions={spec && <Badge tone={valid ? "ok" : "bad"}>{valid ? "Valid" : "Invalid"}</Badge>}
    >
      {valid && spec && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Stat label="Title" value={spec.title ?? "—"} />
          <Stat label="API version" value={spec.version ?? "—"} mono />
          <Stat label="OpenAPI" value={spec.openapiVersion ?? "—"} mono />
          <Stat label="Base URL" value={spec.baseUrl ?? "—"} mono className="col-span-2 sm:col-span-1" />
          <div className="col-span-2 sm:col-span-4">
            <AuthSummary spec={spec} />
          </div>
        </dl>
      )}

      {spec && !valid && spec.validationErrors?.length ? (
        <Notice tone="bad" title="This spec didn't validate">
          <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-xs">
            {spec.validationErrors.slice(0, 6).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {needsUpload && (
        <div className={cx(spec && "mt-5 border-t border-line pt-5")}>
          <Field
            label={spec ? "Upload a corrected spec" : "OpenAPI specification"}
            hint="JSON or YAML"
            htmlFor="spec-content"
          >
            <Textarea
              id="spec-content"
              rows={6}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={'Paste the spec here, or choose a file below…\n\n{\n  "openapi": "3.0.3",\n  ...\n}'}
              className="scroll-slim"
            />
          </Field>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-clay hover:underline">
              <input
                type="file"
                accept=".json,.yaml,.yml,application/json,text/yaml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
              Choose a file…
              <span className="font-mono text-2xs text-ink-faint">{filename}</span>
            </label>
            <Button
              variant="primary"
              loading={action.busy}
              disabled={!content.trim()}
              onClick={() => action.run(() => api.spec.upload(project.id, filename, content), () => setContent(""))}
            >
              Upload & validate
            </Button>
          </div>
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

function AuthSummary({ spec }: { spec: ApiSpec }) {
  const auth = spec.detectedAuth;
  if (!auth) return null;
  if (auth.needsUserConfig) {
    return (
      <Notice tone="warn" title="Authentication couldn't be auto-detected">
        This API appears to require auth, but the scheme isn&apos;t declared in the spec. The
        generated server will default to a bearer token you can configure via{" "}
        <code className="font-mono text-xs">.env</code>.
      </Notice>
    );
  }
  if (!auth.required || auth.schemes.length === 0) {
    return <p className="text-sm text-ink-muted">No authentication required by this API.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink-muted">Detected auth:</span>
      {auth.schemes.map((s, i) => (
        <Badge key={i} tone="ok" dot={false}>
          {s.httpScheme ? `${s.type}/${s.httpScheme}` : s.paramName ? `${s.type} · ${s.paramName}` : s.type}
        </Badge>
      ))}
    </div>
  );
}

/* ── 2 · Tool plan ──────────────────────────────────────────────────────── */

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

/* ── 3 · Generation ─────────────────────────────────────────────────────── */

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

/* ── 4 · Sandbox tests ──────────────────────────────────────────────────── */

const TEST_TERMINAL = new Set(["TESTS_PASSED", "TESTS_FAILED", "SANDBOX_FAILED"]);

export function TestCard({ project, tests, reload }: StageProps & { tests: TestResult[] }) {
  const action = useAction(reload);
  const [showLog, setShowLog] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveLog, setLiveLog] = useState("");
  const streamAbort = useRef<AbortController | null>(null);
  const act = primaryAction(project.status);
  const canRun = act === "run-tests";
  const latest = tests[0];

  // The sandbox run is synchronous and can take a minute — longer than the dev
  // proxy will hold the request open. So we kick it off and poll the project
  // status until it reaches a terminal test state, rather than depending on the
  // long POST resolving. Meanwhile we tail the live SSE log stream (P4-8).
  async function runTests() {
    setRunning(true);
    setLiveLog("");
    action.setError(null);

    const ctrl = new AbortController();
    streamAbort.current = ctrl;
    void api.testing.stream(
      project.id,
      (e) => {
        if (e.type === "log" && e.chunk) setLiveLog((prev) => (prev + e.chunk).slice(-10_000));
      },
      ctrl.signal,
    );

    let fastError: string | null = null;
    void api.testing.run(project.id).catch((err) => {
      // A 4xx is a real, immediate failure worth surfacing; treat a dropped
      // (timed-out) connection as "still running" and let polling resolve it.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) fastError = err.message;
    });
    try {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        if (fastError) break;
        const p = await api.projects.get(project.id);
        if (TEST_TERMINAL.has(p.status) || p.status === "CANCELLED") break;
      }
      if (fastError) action.setError(fastError);
      await reload();
    } catch (err) {
      action.setError(err instanceof ApiError ? err.message : "Could not run the tests.");
    } finally {
      setRunning(false);
      ctrl.abort();
      streamAbort.current = null;
    }
  }

  async function cancelRun() {
    try {
      await api.testing.cancel(project.id);
    } catch {
      // Best-effort — the poll loop will pick up the resulting state.
    }
  }

  return (
    <Panel
      eyebrow="Stage 4"
      title="Sandbox tests"
      description="The generated suite runs in a network-isolated container before anything ships."
      actions={
        latest && (
          <Badge tone={latest.status === "passed" ? "ok" : latest.status === "skipped" ? "warn" : "bad"}>
            {latest.status}
          </Badge>
        )
      }
    >
      {latest ? (
        <>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-3">
            <Stat label="Passed" value={String(latest.totalTestCount - latest.failingTestCount)} mono />
            <Stat label="Failed" value={String(latest.failingTestCount)} mono />
            <Stat label="Duration" value={`${(latest.durationMs / 1000).toFixed(1)}s`} mono />
          </dl>
          {latest.logExcerpt && (
            <div className="mt-4">
              <button
                onClick={() => setShowLog((v) => !v)}
                className="font-mono text-2xs uppercase tracking-eyebrow text-ink-muted hover:text-ink"
              >
                {showLog ? "▾ Hide log" : "▸ Show log"}
              </button>
              {showLog && (
                <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-line bg-ink p-3 font-mono text-2xs leading-relaxed text-paper/90 scroll-slim">
                  {latest.logExcerpt}
                </pre>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-ink-muted">Tests haven&apos;t run yet.</p>
      )}

      {running && liveLog && (
        <div className="mt-4">
          <p className="eyebrow mb-1.5">Live output</p>
          <pre className="max-h-72 overflow-auto rounded-md border border-line bg-ink p-3 font-mono text-2xs leading-relaxed text-paper/90 scroll-slim">
            {liveLog}
          </pre>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
        <span className="font-mono text-2xs text-ink-faint">--network none · read-only · cpu/mem capped</span>
        {canRun &&
          (running ? (
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-2 font-mono text-2xs text-run">
                <Spinner className="text-run" /> running in sandbox…
              </span>
              <Button variant="danger" size="sm" onClick={cancelRun}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button variant="primary" loading={running} onClick={runTests}>
              {latest ? "Re-run tests" : "Run tests"}
            </Button>
          ))}
      </div>
      {action.error && (
        <div className="mt-4">
          <Notice tone="bad">{action.error}</Notice>
        </div>
      )}
    </Panel>
  );
}

/* ── 5 · Completion ─────────────────────────────────────────────────────── */

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
              and an <code className="font-mono text-xs">.env.example</code> — no secrets.
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

function DownloadButton({
  projectId,
  variant,
}: {
  projectId: string;
  variant: "primary" | "secondary";
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { blob, filename } = await api.generation.download(projectId);
          saveBlob(blob, filename);
        } finally {
          setBusy(false);
        }
      }}
    >
      Download ZIP
    </Button>
  );
}

/* ── shared bits ────────────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="eyebrow mb-1">{label}</dt>
      <dd className={cx("truncate text-sm text-ink", mono && "font-mono text-[0.8125rem]")}>{value}</dd>
    </div>
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
