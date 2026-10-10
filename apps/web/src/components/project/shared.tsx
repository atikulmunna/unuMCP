"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cx, saveBlob } from "@/lib/format";
import type { Project } from "@/lib/types";

// Pieces shared by the build-stage cards: their props, the busy/error
// action wrapper, a labelled value, and the ZIP download button.

export interface StageProps {
  project: Project;
  reload: () => Promise<void>;
}

export function useAction(reload: () => Promise<void>) {
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

export function Stat({
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

export function DownloadButton({
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
