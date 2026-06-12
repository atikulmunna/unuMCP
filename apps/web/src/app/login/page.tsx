"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Brand } from "@/components/Brand";
import { Button, Field, Input, Notice } from "@/components/ui";
import { api, ApiError, setToken } from "@/lib/api";

type Mode = "signin" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === "signin"
          ? await api.login(email, password)
          : await api.register(email, password, name || undefined);
      setToken(result.accessToken);
      router.replace("/projects");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Left — the pitch, on drafting paper. */}
      <aside className="bg-blueprint relative hidden flex-col justify-between border-r border-line bg-paper p-12 lg:flex">
        <Brand href="/login" />
        <div className="max-w-md">
          <p className="eyebrow mb-4">From specification to server</p>
          <h1 className="font-serif text-4xl font-semibold leading-[1.1] text-ink">
            Hand it an OpenAPI spec. Get back an MCP server you can actually ship.
          </h1>
          <p className="mt-5 text-[0.95rem] leading-relaxed text-ink-muted">
            unuMCP reads your API, proposes a tool plan for your review, generates a typed
            TypeScript server, and proves it in an isolated sandbox before you download a line of
            it.
          </p>
          <ol className="mt-8 space-y-2.5">
            {["Validate & analyze the spec", "Review the proposed tools", "Generate, test, and package"].map(
              (step, i) => (
                <li key={step} className="flex items-center gap-3 text-sm text-ink-soft">
                  <span className="grid h-6 w-6 place-items-center rounded-full border border-line-strong bg-panel font-mono text-2xs text-ink-muted">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ),
            )}
          </ol>
        </div>
        <p className="font-mono text-2xs text-ink-faint">Deterministic builds · Sandboxed tests · No secrets leave the box</p>
      </aside>

      {/* Right — the form. */}
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm animate-fade-up">
          <div className="mb-8 lg:hidden">
            <Brand href="/login" />
          </div>

          <h2 className="font-serif text-2xl font-semibold text-ink">
            {mode === "signin" ? "Welcome back" : "Create your account"}
          </h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            {mode === "signin"
              ? "Sign in to pick up where your builds left off."
              : "Start turning specs into servers in minutes."}
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            {mode === "register" && (
              <Field label="Name" hint="optional" htmlFor="name">
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                />
              </Field>
            )}
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
              />
            </Field>

            {error && <Notice tone="bad">{error}</Notice>}

            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              {mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-ink-muted">
            {mode === "signin" ? "New to unuMCP?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "register" : "signin");
                setError(null);
              }}
              className="font-medium text-clay underline-offset-4 hover:underline"
            >
              {mode === "signin" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
