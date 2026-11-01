"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Notice, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { primaryAction } from "@/lib/status";
import { fixImpact, usabilityScoreLine } from "@/lib/usability";
import type { UsabilityFix, UsabilityRun, UsabilityState, UsabilityTask } from "@/lib/types";
import type { StageProps } from "./shared";

const POLL_MS = 3000;
const MAX_WAIT_MS = 10 * 60_000;

type Decision = "accept" | "reject";

const FIX_TONE: Record<UsabilityFix["status"], "clay" | "ok" | "neutral" | "warn"> = {
  proposed: "clay",
  accepted: "ok",
  rejected: "neutral",
  stale: "warn",
};

const messageOf = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * The agent usability check, inside the Tool plan card: run it while the plan
 * is under review, then accept or reject the suggested fixes one by one.
 */
export function UsabilityPanel({ project, reload }: StageProps) {
  const [state, setState] = useState<UsabilityState | null>(null);
  const [checking, setChecking] = useState(false);
  const [busyFix, setBusyFix] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewing = primaryAction(project.status) === "approve-tools";

  const load = useCallback(async () => {
    const next = await api.usability.get(project.id);
    setState(next);
    return next;
  }, [project.id]);

  useEffect(() => {
    load().catch((err) => setError(messageOf(err, "Could not load the usability check.")));
  }, [load]);

  // A check can outlast the dev proxy's request timeout, so it is started and
  // then polled until a new run settles, like the sandbox test run.
  async function check() {
    setChecking(true);
    setError(null);
    const previous = state?.run?.id;
    const refused: { message: string | null } = { message: null };
    api.usability.start(project.id).catch((err) => {
      refused.message = messageOf(err, "Could not start the check.");
    });
    try {
      const deadline = Date.now() + MAX_WAIT_MS;
      while (Date.now() < deadline && !refused.message) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const next = await load();
        if (next.run && next.run.id !== previous && next.run.status !== "running") break;
      }
      if (refused.message) setError(refused.message);
    } catch (err) {
      setError(messageOf(err, "Could not follow the check."));
    } finally {
      setChecking(false);
    }
  }

  async function decide(fix: UsabilityFix, decision: Decision) {
    setBusyFix(fix.id);
    setError(null);
    try {
      await (decision === "accept" ? api.usability.accept : api.usability.reject)(project.id, fix.id);
      await reload(); // an accepted fix changes the tool's text
    } catch (err) {
      setError(messageOf(err, "Could not apply the decision."));
    }
    try {
      await load(); // shows the new status, including a fix that went stale
    } catch (err) {
      setError((prev) => prev ?? messageOf(err, "Could not refresh the check."));
    }
    setBusyFix(null);
  }

  if (!state || (!reviewing && !state.run)) return null;
  return (
    <div className="border-t border-line px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="eyebrow mb-1">Agent usability</p>
          <p className="text-sm text-ink-muted">
            An AI agent gets a realistic request for each tool and must pick the right tool with the right
            arguments. Tools it gets wrong come back with clearer descriptions for you to review.
          </p>
        </div>
        {reviewing && (
          <Button size="sm" loading={checking} disabled={!state.llmEnabled || checking} onClick={check}>
            Check agent usability
          </Button>
        )}
      </div>
      {reviewing && !state.llmEnabled && (
        <p className="mt-2 text-xs text-ink-faint">
          Needs the LLM: set LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY on the server.
        </p>
      )}
      {checking && (
        <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
          <Spinner /> Checking. This usually takes a minute or two.
        </p>
      )}
      {!checking && state.run && (
        <RunResult run={state.run} reviewing={reviewing} busyFix={busyFix} onDecide={decide} />
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
    </div>
  );
}

function RunResult({
  run,
  reviewing,
  busyFix,
  onDecide,
}: {
  run: UsabilityRun;
  reviewing: boolean;
  busyFix: string | null;
  onDecide: (fix: UsabilityFix, decision: Decision) => void;
}) {
  if (run.status === "running") {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <Spinner /> A check is running.
      </p>
    );
  }
  if (run.status === "failed") {
    return (
      <div className="mt-3">
        <Notice tone="bad" title="The check did not finish">
          {run.errorMessage}
        </Notice>
      </div>
    );
  }
  const missed = run.tasks.filter((t) => t.outcome === "wrong_tool" || t.outcome === "bad_args");
  return (
    <div className="mt-3 space-y-3">
      <div>
        <p className="text-sm text-ink">{usabilityScoreLine(run)}</p>
        <p className="mt-0.5 font-mono text-2xs text-ink-faint">
          Estimated cost ${Number(run.estimatedCostUsd).toFixed(4)}
        </p>
      </div>
      {run.note && <Notice tone="warn">{run.note}</Notice>}
      {missed.length > 0 && <MissList tasks={missed} />}
      {run.fixes.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5">Suggested fixes</p>
          <ul className="space-y-2">
            {run.fixes.map((fix) => (
              <FixItem
                key={fix.id}
                fix={fix}
                reviewing={reviewing}
                busy={busyFix === fix.id}
                onDecide={onDecide}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MissList({ tasks }: { tasks: UsabilityTask[] }) {
  return (
    <div>
      <p className="eyebrow mb-1.5">What the agent got wrong</p>
      <ul className="space-y-1.5">
        {tasks.map((t) => (
          <li key={t.id} className="text-sm">
            <span className="text-ink">&ldquo;{t.prompt}&rdquo;</span>{" "}
            <span className="text-ink-muted">
              Needed <code className="font-mono text-xs">{t.toolName}</code>;{" "}
              {t.outcome === "wrong_tool" ? (
                <>
                  picked <code className="font-mono text-xs">{t.chosenTool}</code>.
                </>
              ) : (
                t.reason
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FixItem({
  fix,
  reviewing,
  busy,
  onDecide,
}: {
  fix: UsabilityFix;
  reviewing: boolean;
  busy: boolean;
  onDecide: (fix: UsabilityFix, decision: Decision) => void;
}) {
  return (
    <li className="rounded-md border border-line px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm font-medium text-ink">{fix.toolName}</code>
        {fix.afterName && (
          <span className="text-xs text-ink-muted">
            rename to <code className="font-mono">{fix.afterName}</code>
          </span>
        )}
        <Badge tone={FIX_TONE[fix.status]} dot={false}>
          {fix.status}
        </Badge>
        <span className="font-mono text-2xs text-ink-faint">{fixImpact(fix)}</span>
      </div>
      <dl className="mt-2 space-y-1 text-sm">
        <div>
          <dt className="eyebrow">Now</dt>
          <dd className="text-ink-muted">{fix.beforeDescription}</dd>
        </div>
        <div>
          <dt className="eyebrow">Suggested</dt>
          <dd className="text-ink">{fix.afterDescription}</dd>
        </div>
      </dl>
      {reviewing && fix.status === "proposed" && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="primary" loading={busy} onClick={() => onDecide(fix, "accept")}>
            Accept
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(fix, "reject")}>
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}
