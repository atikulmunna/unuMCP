"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { Badge, Button, EmptyState, Field, Input, Notice, Spinner, Textarea } from "@/components/ui";
import { useSession } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import { statusMeta } from "@/lib/status";
import { cx, timeAgo } from "@/lib/format";
import type { Project } from "@/lib/types";

export default function ProjectsPage() {
  const { user, loading: sessionLoading } = useSession();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setProjects(await api.projects.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load projects.");
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (sessionLoading || !user) {
    return <FullPageSpinner />;
  }

  return (
    <div className="min-h-screen">
      <TopBar user={user} />
      <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow mb-2">Workspace</p>
            <h1 className="font-serif text-3xl font-semibold text-ink">Projects</h1>
            <p className="mt-1.5 text-sm text-ink-muted">
              Each project carries one API from specification through to a packaged server.
            </p>
          </div>
          <Button variant="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? "Close" : "New project"}
          </Button>
        </div>

        {creating && (
          <div className="mt-6 animate-fade-up">
            <NewProjectForm
              onCancel={() => setCreating(false)}
              onCreated={(p) => {
                setCreating(false);
                setProjects((prev) => (prev ? [p, ...prev] : [p]));
              }}
            />
          </div>
        )}

        {error && (
          <div className="mt-6">
            <Notice tone="bad">{error}</Notice>
          </div>
        )}

        <div className="mt-8">
          {projects === null ? (
            <FullPageSpinner inline />
          ) : projects.length === 0 ? (
            <EmptyState
              title="No projects yet"
              action={
                !creating && (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Create your first project
                  </Button>
                )
              }
            >
              Start by creating a project, then upload the OpenAPI spec for the API you want to
              expose to agents.
            </EmptyState>
          ) : (
            <ProjectList projects={projects} />
          )}
        </div>
      </main>
    </div>
  );
}

function ProjectList({ projects }: { projects: Project[] }) {
  return (
    <ul className="overflow-hidden rounded-lg border border-line bg-panel shadow-card">
      {projects.map((project, i) => {
        const meta = statusMeta(project.status);
        return (
          <li key={project.id}>
            <Link
              href={`/projects/${project.id}`}
              className={cx(
                "group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-paper/70",
                i > 0 && "border-t border-line",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <h3 className="truncate font-serif text-lg font-medium text-ink">{project.name}</h3>
                </div>
                <p className="mt-0.5 truncate text-sm text-ink-muted">
                  {project.description || "No description"}
                </p>
              </div>
              <span className="hidden font-mono text-2xs text-ink-faint sm:inline">
                {timeAgo(project.updatedAt)}
              </span>
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <span className="text-ink-faint transition-transform group-hover:translate-x-0.5" aria-hidden>
                →
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function NewProjectForm({
  onCreated,
  onCancel,
}: {
  onCreated: (p: Project) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const project = await api.projects.create(name.trim(), description.trim() || undefined);
      onCreated(project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the project.");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-line bg-panel p-5 shadow-card"
    >
      <p className="eyebrow mb-4">New project</p>
      <div className="space-y-4">
        <Field label="Project name" htmlFor="proj-name">
          <Input
            id="proj-name"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Stripe billing, Internal orders API…"
          />
        </Field>
        <Field label="Description" hint="optional" htmlFor="proj-desc">
          <Textarea
            id="proj-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this API for?"
            className="font-sans text-sm"
          />
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            Create project
          </Button>
        </div>
      </div>
    </form>
  );
}

function FullPageSpinner({ inline = false }: { inline?: boolean }) {
  return (
    <div className={cx("flex items-center justify-center text-ink-faint", inline ? "py-16" : "min-h-screen")}>
      <Spinner className="h-5 w-5 text-clay" />
    </div>
  );
}
