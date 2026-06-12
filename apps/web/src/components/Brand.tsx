import Link from "next/link";
import { cx } from "@/lib/format";

/** Wordmark: lowercase serif "unu", a small clay tile, then "mcp" in mono —
 *  reads as a maker's mark, not a logo-generator output. */
export function Brand({ className, href = "/projects" }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cx("group inline-flex items-baseline gap-1.5", className)}>
      <span className="font-serif text-xl font-semibold tracking-tight text-ink">unu</span>
      <span className="mb-0.5 h-2 w-2 self-center rounded-[2px] bg-clay transition-transform group-hover:rotate-12" />
      <span className="font-mono text-sm font-medium tracking-tight text-ink-muted">mcp</span>
    </Link>
  );
}
