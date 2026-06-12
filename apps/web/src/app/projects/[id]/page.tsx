"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { Pipeline } from "@/components/Pipeline";
import { Badge, Notice, Panel, Spinner } from "@/components/ui";
import { AuditTrail } from "@/components/project/AuditTrail";
import {
  CompleteCard,
  GenerateCard,
  SpecCard,
  TestCard,
  ToolsCard,
} from "@/components/project/stages";
import { useSession } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import { currentStage, statusMeta } from "@/lib/status";
import { clockTime } from "@/lib/format";
import type {
  ApiSpec,
  AuditEvent,
  GenerationLatest,
  Project,
  TestResult,
  ToolCandidate,
} from "@/lib/types";

interface Bundle {
  project: Project;
  spec: ApiSpec | null;
  tools: ToolCandidate[];
  generation: GenerationLatest | null;
  tests: TestResult[];
  audit: AuditEvent[];
}

export default function ProjectDetailPage() {
  const { user, loading: sessionLoading } = useSession();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const project = await api.projects.get(id);
      const [spec, tools, generation, tests, audit] = await Promise.all([
        api.spec.get(id),
        api.tools.list(id),
        api.generation.latest(id),
        api.testing.results(id),
        api.projects.audit(id),
      ]);
      // List endpoints can 200 with an empty body (e.g. no runs yet), which the
      // client resolves to undefined — coerce those back to empty arrays.
      setBundle({
        project,
        spec: spec ?? null,
        tools: tools ?? [],
        generation: generation ?? null,
        tests: tests ?? [],
        audit: audit ?? [],
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        router.replace("/projects");
        return;
      }
      setError(err instanceof ApiError ? err.message : "Could not load this project.");
    }
  }, [id, router]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (sessionLoading || !user || (!bundle && !error)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-5 w-5 text-clay" />
      </div>
    );
  }

  if (error || !bundle) {
    return (
      <div className="min-h-screen">
        <TopBar user={user} />
        <main className="mx-auto max-w-3xl px-5 py-16">
          <Notice tone="bad" title="Couldn't load project">
            {error}
          </Notice>
          <Link href="/projects" className="mt-4 inline-block text-sm text-clay hover:underline">
            ← Back to projects
          </Link>
        </main>
      </div>
    );
  }

  const { project, spec, tools, generation, tests, audit } = bundle;
  const meta = statusMeta(project.status);
  const stage = currentStage(project.status);
  const reached = (n: number) => stage >= n;

  return (
    <div className="min-h-screen">
      <TopBar user={user} />
      <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
        <Link href="/projects" className="font-mono text-2xs text-ink-muted hover:text-ink">
          ← Projects
        </Link>

        {/* Header */}
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-serif text-3xl font-semibold leading-tight text-ink">{project.name}</h1>
            <p className="mt-1 text-sm text-ink-muted">{project.description || "No description"}</p>
            <p className="mt-2 font-mono text-2xs text-ink-faint">
              {project.id} · created {clockTime(project.createdAt)}
            </p>
          </div>
          <Badge tone={meta.tone} pulse={meta.tone === "run"}>
            {meta.label}
          </Badge>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[280px_1fr]">
          {/* Left rail: pipeline + provenance */}
          <div className="space-y-6 lg:sticky lg:top-20 lg:self-start">
            <Panel eyebrow="Build pipeline" title="Progress" bodyClassName="px-5 py-5">
              <Pipeline status={project.status} />
            </Panel>
            <Panel eyebrow="Provenance" title="Activity" bodyClassName="p-0">
              <AuditTrail events={audit} />
            </Panel>
          </div>

          {/* Right: the active workbench, stage by stage */}
          <div className="space-y-5">
            <SpecCard project={project} spec={spec} reload={load} />
            {(reached(1) || tools.length > 0) && (
              <ToolsCard project={project} tools={tools} reload={load} />
            )}
            {(reached(2) || generation) && (
              <GenerateCard project={project} generation={generation} reload={load} />
            )}
            {(reached(3) || tests.length > 0) && (
              <TestCard project={project} tests={tests} reload={load} />
            )}
            {reached(4) && <CompleteCard project={project} reload={load} />}
          </div>
        </div>
      </main>
    </div>
  );
}
