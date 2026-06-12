import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/format";
import type { Tone } from "@/lib/status";

/* ── Button ─────────────────────────────────────────────────────────────── */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-ink text-paper border-ink hover:bg-ink-soft active:bg-ink disabled:bg-ink/40",
  secondary: "bg-panel text-ink border-line-strong hover:border-ink/40 hover:bg-paper",
  ghost: "bg-transparent text-ink-soft border-transparent hover:bg-ink/[0.05]",
  danger: "bg-panel text-bad border-bad/30 hover:bg-bad/[0.06] hover:border-bad/50",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[0.8125rem]",
  md: "h-10 px-4 text-sm",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 rounded border font-medium",
        "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-70",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    >
      {loading && <Spinner className={variant === "primary" ? "text-paper" : "text-ink"} />}
      {children}
    </button>
  );
}

/* ── Spinner ────────────────────────────────────────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx("h-3.5 w-3.5 animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ── Panel ──────────────────────────────────────────────────────────────── */

interface PanelProps {
  eyebrow?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Panel({
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: PanelProps) {
  const hasHeader = eyebrow || title || description || actions;
  return (
    <section className={cx("rounded-lg border border-line bg-panel shadow-card", className)}>
      {hasHeader && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
            {title && <h2 className="text-lg leading-tight">{title}</h2>}
            {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children && <div className={cx("px-5 py-4", bodyClassName)}>{children}</div>}
    </section>
  );
}

/* ── Badge / status pip ─────────────────────────────────────────────────── */

const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-ink/[0.05] text-ink-soft border-line-strong",
  clay: "bg-clay-wash text-clay border-clay/25",
  ok: "bg-ok-wash text-ok border-ok/25",
  warn: "bg-warn-wash text-warn border-warn/25",
  bad: "bg-bad-wash text-bad border-bad/25",
  run: "bg-run-wash text-run border-run/25",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-faint",
  clay: "bg-clay",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  run: "bg-run",
};

export function Badge({
  tone = "neutral",
  dot = true,
  pulse = false,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5",
        "font-mono text-2xs uppercase tracking-eyebrow",
        TONE_BADGE[tone],
        className,
      )}
    >
      {dot && (
        <span className={cx("h-1.5 w-1.5 rounded-full", TONE_DOT[tone], pulse && "animate-pulse-soft")} />
      )}
      {children}
    </span>
  );
}

/* ── Form fields ────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block">
      <span className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink-soft">{label}</span>
        {hint && <span className="text-xs text-ink-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const FIELD_BASE =
  "w-full rounded-md border border-line-strong bg-paper/60 px-3 text-sm text-ink " +
  "placeholder:text-ink-faint transition-colors focus:border-clay/50 focus:bg-panel";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(FIELD_BASE, "h-10", className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(FIELD_BASE, "py-2.5 font-mono text-xs leading-relaxed", className)} />;
}

/* ── Inline notice ──────────────────────────────────────────────────────── */

export function Notice({
  tone = "bad",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx("rounded-md border px-3.5 py-3 text-sm", TONE_BADGE[tone])}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cx(title && "mt-0.5", "opacity-90")}>{children}</div>}
    </div>
  );
}

/* ── Empty state ────────────────────────────────────────────────────────── */

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-paper/40 px-6 py-12 text-center">
      <h3 className="text-base text-ink-soft">{title}</h3>
      {children && <p className="mt-1.5 max-w-sm text-sm text-ink-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
