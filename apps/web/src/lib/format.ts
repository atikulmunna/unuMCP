/** className joiner — keeps conditional Tailwind readable without a dependency. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Trigger a browser download for an already-fetched blob. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const ABSOLUTE = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = then - Date.now();
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 60) return RELATIVE.format(mins, "minute");
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return RELATIVE.format(days, "day");
  return ABSOLUTE.format(then);
}

export function clockTime(iso: string): string {
  return ABSOLUTE.format(new Date(iso));
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
