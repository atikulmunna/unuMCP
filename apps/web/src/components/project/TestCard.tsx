"use client";

import { useRef, useState } from "react";
import { Badge, Button, Notice, Panel, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { primaryAction } from "@/lib/status";
import type { TestResult } from "@/lib/types";
import { Stat, useAction, type StageProps } from "./shared";

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

  // The sandbox run is synchronous and can take a minute, longer than the dev
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
      // Best-effort: the poll loop will pick up the resulting state.
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
