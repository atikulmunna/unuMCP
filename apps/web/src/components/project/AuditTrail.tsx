import { cx, timeAgo } from "@/lib/format";
import type { AuditEvent } from "@/lib/types";

const ACTOR_TONE: Record<AuditEvent["actor"], string> = {
  user: "bg-clay",
  agent: "bg-run",
  system: "bg-ink-faint",
};

/** A quiet, append-only log of what happened to this project — the provenance
 *  record that makes the build trustworthy. */
export function AuditTrail({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return <p className="px-5 py-4 text-sm text-ink-muted">No activity recorded yet.</p>;
  }
  return (
    <ol className="px-5 py-1">
      {events.map((event, i) => (
        <li key={event.id} className="relative flex gap-3 py-2.5">
          {i !== events.length - 1 && (
            <span aria-hidden className="absolute left-[3px] top-5 h-full w-px bg-line" />
          )}
          <span className={cx("mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full", ACTOR_TONE[event.actor])} />
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-snug text-ink-soft">{event.summary}</p>
            <p className="mt-0.5 font-mono text-2xs text-ink-faint">
              {event.actor} · {timeAgo(event.createdAt)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
