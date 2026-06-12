import { cx } from "@/lib/format";
import { pipeline, type Phase, type StageView } from "@/lib/status";
import type { ProjectStatus } from "@/lib/types";
import { Spinner } from "./ui";

/** The build traveler card: a vertical ledger of the five stages with the
 *  project's live position. This is the spine of the project view. */
export function Pipeline({ status }: { status: ProjectStatus }) {
  const stages = pipeline(status);
  return (
    <ol className="relative">
      {stages.map((stage, i) => (
        <Row key={stage.key} stage={stage} last={i === stages.length - 1} />
      ))}
    </ol>
  );
}

function Row({ stage, last }: { stage: StageView; last: boolean }) {
  const active = stage.phase === "active" || stage.phase === "busy";
  return (
    <li className="relative flex gap-3.5 pb-5 last:pb-0">
      {!last && (
        <span
          aria-hidden
          className={cx(
            "absolute left-[11px] top-7 h-[calc(100%-1.25rem)] w-px",
            stage.phase === "done" ? "bg-ok/40" : "bg-line-strong",
          )}
        />
      )}
      <Marker phase={stage.phase} />
      <div className={cx("min-w-0 pt-0.5", !active && stage.phase === "pending" && "opacity-55")}>
        <p
          className={cx(
            "text-sm font-medium leading-tight",
            active ? "text-ink" : "text-ink-soft",
          )}
        >
          {stage.label}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted">{stage.hint}</p>
      </div>
    </li>
  );
}

const MARKER_RING: Record<Phase, string> = {
  done: "border-ok bg-ok text-paper",
  active: "border-clay bg-clay-wash text-clay shadow-ring",
  busy: "border-run bg-run-wash text-run",
  error: "border-bad bg-bad-wash text-bad",
  pending: "border-line-strong bg-paper text-ink-faint",
};

function Marker({ phase }: { phase: Phase }) {
  return (
    <span
      className={cx(
        "relative z-10 grid h-[23px] w-[23px] shrink-0 place-items-center rounded-full border-2",
        MARKER_RING[phase],
      )}
    >
      {phase === "done" && <CheckIcon />}
      {phase === "error" && <CrossIcon />}
      {phase === "busy" && <Spinner className="h-3 w-3" />}
      {phase === "active" && <span className="h-2 w-2 rounded-full bg-clay animate-pulse-soft" />}
      {phase === "pending" && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
