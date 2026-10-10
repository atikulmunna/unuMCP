"use client";

import { useState } from "react";
import { Badge, Button, Field, Notice, Panel, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { primaryAction } from "@/lib/status";
import { cx } from "@/lib/format";
import type { ApiSpec } from "@/lib/types";
import { Stat, useAction, type StageProps } from "./shared";

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
          <Stat label="Title" value={spec.title ?? "Not set"} />
          <Stat label="API version" value={spec.version ?? "Not set"} mono />
          <Stat label="OpenAPI" value={spec.openapiVersion ?? "Not set"} mono />
          <Stat label="Base URL" value={spec.baseUrl ?? "Not set"} mono className="col-span-2 sm:col-span-1" />
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
