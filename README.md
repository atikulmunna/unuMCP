# unuMCP

Turn an **OpenAPI specification** into a working, tested **TypeScript MCP server** — with a human approval step, a deterministic code generator, a sandboxed test run, and a bounded self-repair loop.

You upload a spec; unuMCP analyses the endpoints, proposes tools (names, input schemas, risk levels), lets you approve them, generates a complete MCP server project, runs its tests in an isolated Docker sandbox, repairs failing code, and hands back a downloadable ZIP — README and `.env.example` included, secrets never.

---

## Table of contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Running the apps](#running-the-apps)
- [Testing](#testing)
- [Security posture](#security-posture)
- [Operational notes](#operational-notes)

---

## How it works

The platform is a **deterministic pipeline with one human gate**, not an open-ended agent loop. Each stage advances a `Project` through an auditable state machine (every transition writes a `GenerationRun` status + an `AuditEvent`).

```
Upload OpenAPI spec
  → validate + dereference ($ref / allOf / oneOf)
  → analyse endpoints → propose tools (deterministic name + risk + input schema;
                                       optional LLM-authored descriptions)
  → 👤 human approval  (high-risk tools disabled by default)
  → generate TypeScript MCP server  (deterministic codegen)
  → static security scan  (refuse code that smells of secrets / exfiltration / eval)
  → run tests in a two-phase Docker sandbox  (install online → test offline)
  → on failure: bounded self-repair loop  (fix implementation only, tests frozen)
  → complete → download ZIP  (sources + tests + README + .env.example, no secrets)
```

Design principles worth knowing before you read the code:

- **Determinism first.** All *structural* artifacts (project scaffold, handler wiring, env detection, tests) are generated deterministically. The LLM is used **only** for prose (tool descriptions) and for repair edits — never to produce structural code. The platform runs end-to-end with the LLM disabled (you just get fallback descriptions and no repair).
- **The LLM is swappable.** `@unumcp/llm` is a provider-agnostic seam; the current implementation targets **NVIDIA NIM** (OpenAI-compatible). See [Environment variables](#environment-variables).
- **Tests are frozen during repair.** The repair loop may edit implementation files only; it can never weaken a test to force a pass (enforced by both the prompt and the parser).

## Architecture

| Layer | Tech | Notes |
| --- | --- | --- |
| Backend / orchestrator | **NestJS 11** | DI + guards map cleanly to the auth/authz and multi-stage layout |
| Frontend dashboard | **Next.js 15** (App Router), React 19, Tailwind v3 | Same-origin `/api/*` proxied to the backend (no CORS needed) |
| Database | **PostgreSQL 16** via **Prisma** | Projects, runs, tools, test results, repair attempts, audit log |
| Background jobs | **BullMQ + Redis** (optional) | Long-running generation/test/repair survive restarts; falls back to inline |
| Sandbox | **Docker** two-phase runner | Phase 1 installs (network on); Phase 2 tests with `--network none` + resource caps |
| LLM | **NVIDIA NIM** (OpenAI-compatible), via `@unumcp/llm` | Provider-agnostic; optional — platform degrades gracefully without it |
| Monorepo | **pnpm workspaces + Turborepo** | Shared `packages/*`, cached `build`/`test`/`typecheck` |

## Repository layout

```
apps/
  api/      NestJS backend: REST API + the pipeline orchestrator, jobs, sandbox, repair
  web/      Next.js dashboard: spec upload, tool approval, pipeline progress, downloads
packages/
  openapi/        Parse/validate OpenAPI, dereference $ref/allOf/oneOf, extract endpoints, detect auth
  analysis/       Endpoint → tool classification, deterministic naming, risk scoring, proposal assembly
  schema-gen/     JSON Schema → Zod input-schema generation
  codegen/        Deterministic TypeScript MCP server generation (project, handlers, tests, README, .env.example)
  sandbox/        Two-phase Docker sandbox runner + Vitest summary parser
  security-scan/  Secret redaction, static scan of generated code, prompt-injection detection
  llm/            Provider-agnostic LLM client (NVIDIA NIM): tool-description proposal + code repair
  db/             Prisma schema + generated client
```

> **Note on untracked docs:** `unuMCP_SRS.md`, `tasks.md`, and `CLAUDE.md` are intentionally git-ignored (local planning/spec docs). This README is the canonical project documentation.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm 11.5.1** (`corepack enable` will pin it from `packageManager`)
- **Docker** — required both for local Postgres/Redis (`docker compose`) **and** for the test sandbox that runs a generated server's tests

## Quick start

```bash
# 1. Install workspace deps (generates the Prisma client on postinstall)
pnpm install

# 2. Start Postgres (:5433) and Redis (:6379)
docker compose up -d

# 3. Configure env for the API
cp .env.example apps/api/.env
#   then edit apps/api/.env — at minimum set DATABASE_URL and JWT_SECRET
#   (NVIDIA_API_KEY and REDIS_URL are optional; see below)

# 4. Apply the database schema.
#   Prisma reads DATABASE_URL from the environment (NOT apps/api/.env), and it
#   defaults to the docker-compose database, so make sure it's exported:
DATABASE_URL=postgresql://unumcp:unumcp@localhost:5433/unumcp \
  pnpm --filter @unumcp/db exec prisma db push        # or: prisma migrate dev

# 5. Run the backend (http://localhost:3001/api)
pnpm --filter @unumcp/api dev

# 6. In another terminal, run the dashboard (http://localhost:3000)
pnpm --filter @unumcp/web dev
```

Open <http://localhost:3000>, register an account, create a project, and upload an OpenAPI spec to start the pipeline.

## Environment variables

The API loads `apps/api/.env` (via Node's `--env-file`). Copy `.env.example` and adjust. All keys:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | `postgresql://unumcp:unumcp@localhost:5433/unumcp` | Postgres connection (Prisma) |
| `JWT_SECRET` | **yes** | — | Signs/verifies auth tokens |
| `PORT` | no | `3001` | API listen port |
| `NVIDIA_API_KEY` | no | — | NVIDIA NIM key. **Absent ⇒ LLM features disabled** (deterministic fallback, no repair). `NIM_API_KEY` is also accepted |
| `NIM_MODEL` | no | `meta/llama-3.3-70b-instruct` | NIM model id (OpenAI-compatible chat) |
| `LLM_DISABLED` | no | — | Set `true` to force-disable the LLM even with a key |
| `REDIS_URL` | no | — | **Absent ⇒ jobs run inline.** Set to enable the durable BullMQ queue |
| `JOBS_INLINE` | no | — | Set `true` to force inline execution even with `REDIS_URL` |
| `JOB_ATTEMPTS` | no | `3` | BullMQ retry attempts per job |
| `JOB_CONCURRENCY` | no | `2` | Worker concurrency |
| `MAX_REPAIR_ATTEMPTS` | no | `2` | Bounded self-repair passes (each ≈ one LLM call + a full sandbox rerun) |
| `REPAIR_MAX_TOKENS` | no | `4096` | Token ceiling per repair pass |
| `RATE_LIMIT_MAX` | no | `60` | Requests per window |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Rate-limit window |
| `RATE_LIMIT_DISABLED` | no | — | Set `true` to disable rate limiting |
| `STORAGE_DIR` | no | OS temp dir | Where generated artifacts are stored locally |

The **web** app honours `API_URL` (default `http://localhost:3001`) for the Next rewrite that proxies `/api/*` to the backend.

> **Secrets never leave the platform.** Generated archives contain only `.env.example` placeholders — never a populated `.env`. Secret-shaped values are redacted from logs and error messages.

## Running the apps

**Backend.** Start it with the workspace script:

```bash
pnpm --filter @unumcp/api dev     # watch mode
pnpm --filter @unumcp/api start   # one-shot
```

> ⚠️ The API scripts run under `node -r @swc-node/register`, **not** `tsx`. NestJS needs `emitDecoratorMetadata` for constructor DI; SWC emits it, esbuild/tsx does not. Don't "simplify" these scripts to `tsx`.

**Dashboard.** Start the API first (it needs Postgres), then:

```bash
pnpm --filter @unumcp/web dev     # Next dev on :3000, proxies /api → :3001
```

The browser keeps the JWT in `localStorage` and calls same-origin `/api/*`; Next rewrites proxy those to the backend, so the API needs no CORS configuration.

## Testing

```bash
pnpm test          # all packages via Turborepo
pnpm typecheck     # tsc --noEmit across the workspace
```

Per package / app:

```bash
pnpm exec turbo run typecheck test --filter=@unumcp/llm
pnpm exec turbo run typecheck test build --filter=@unumcp/web
```

Notes:

- **The API test suite needs a Postgres with the schema applied** (it exercises real Prisma against `DATABASE_URL`). Bring up `docker compose` and run `prisma db push` first.
- The **real-Redis queue round-trip** test is opt-in: it only runs when `REDIS_URL` is set (the default suite runs jobs inline).
- The **real Docker sandbox** path is validated via spikes and the testing e2e; unit/e2e tests use an injectable fake sandbox so they don't require Docker.

## Security posture

- **Human approval gate** before any code is generated; high-risk tools (destructive verbs) are disabled by default.
- **Static security scan** of generated code before it is persisted or packaged — refuses injected secrets, exfiltration hosts, and `eval`/shell patterns.
- **Two-phase sandbox**: dependency install runs with network; the test phase runs `--network none` with CPU/memory/pid caps, read-only FS, and a SIGKILL timeout.
- **Prompt-injection detection** on untrusted spec text feeding the LLM; the description prompt treats spec content as untrusted data.
- **Secret redaction** across logs, error envelopes, and persisted sandbox output.
- **Sanitized error responses**: a single exception filter returns a structured envelope with a correlation id; 5xx bodies are generic (details stay server-side).
- **Rate limiting** on the API (per-IP token buckets).

## Operational notes

- **Jobs are opt-in durable.** With no `REDIS_URL`, generation/test/repair run inline in-request — fine for dev and CI. Set `REDIS_URL` to route them through BullMQ so they survive restarts; a boot-time reconciler fails any run orphaned by a crash (stale > 5 min) so the pipeline never hangs.
- **The repair loop runs on the queue.** A clean test failure triggers up to `MAX_REPAIR_ATTEMPTS` passes (LLM fix → sandbox rerun). On exhaustion the project settles on `TESTS_FAILED` — never a silent success — and the user may still download partial output, with warnings embedded.
- **NIM catalog churns.** Model ids reach end-of-life periodically; pin a model but be ready to swap `NIM_MODEL`.
- **Local storage for MVP.** Artifacts are written under `STORAGE_DIR` (temp dir by default); the storage layer is abstracted so an object store can replace it without touching callers.
