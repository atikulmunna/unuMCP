# unuMCP

[![Live demo — request access](https://img.shields.io/badge/%E2%97%8F%20Live%20demo-request%20access-2e7d32?style=for-the-badge)](https://aimunna.me/unuMCP/)

Turn an **OpenAPI specification** into a working, tested **TypeScript MCP server** — with a human approval step, a deterministic code generator, a sandboxed test run, and a bounded self-repair loop.

You upload a spec; unuMCP analyses the endpoints, proposes tools (names, input schemas, risk levels), lets you approve them, generates a complete MCP server project, runs its tests in an isolated Docker sandbox, repairs failing code, and hands back a downloadable ZIP — README and `.env.example` included, secrets never.

![unuMCP dashboard — the project build pipeline](assets/unumcp.png)

> The project workbench: a five-stage build pipeline (left), the validated spec with **auto-detected bearer auth**, and the approved **tool plan** whose descriptions were authored live by the LLM. Captured from a live AWS deploy (see [Deployment](#deployment)).

---

## Table of contents

- [Live demo](#live-demo)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Running the apps](#running-the-apps)
- [Testing](#testing)
- [Observability](#observability)
- [Security posture](#security-posture)
- [Deployment](#deployment)
- [Operational notes](#operational-notes)

---

## Live demo

The demo runs on an **on-demand** cloud box that is **kept switched off to keep hosting costs near zero** — there is deliberately no always-on public URL (see [Deployment](#deployment) for why: it needs a real Docker daemon for the sandbox, which isn't free to run 24/7).

**Want to see it live?** Open the **[live-demo page](https://aimunna.me/unuMCP/)** (that's where the badge above goes), or reach out directly and the author will spin the server up (~30 seconds) and send you a URL — then take it down again afterwards:

- 📧 **Atikul Munna** — [atikul.munna@northsouth.edu](mailto:atikul.munna@northsouth.edu?subject=unuMCP%20live%20demo%20request)

In the meantime, the [screenshot above](#unumcp) and [How it works](#how-it-works) walk through the entire pipeline.

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
  → run tests in a locked-down Docker sandbox  (deps prebuilt into the image, test offline)
  → on failure: bounded self-repair loop  (fix implementation only, tests frozen)
  → complete → download ZIP  (sources + tests + README + .env.example, no secrets)
```

Design principles worth knowing before you read the code:

- **Determinism first.** All *structural* artifacts (project scaffold, handler wiring, env detection, tests) are generated deterministically. The LLM is used **only** for prose (tool descriptions) and for repair edits — never to produce structural code. The platform runs end-to-end with the LLM disabled (you just get fallback descriptions and no repair).
- **The LLM is swappable.** `@unumcp/llm` is a provider-agnostic seam. It ships with **Google Gemini** (free tier) and **NVIDIA NIM** over their OpenAI-compatible APIs, auto-selected from whichever key is set, plus **Anthropic Claude** (default Claude Haiku 4.5) via the official SDK as a paid, explicit opt-in. Descriptions are proposed in **batches** (many tools per call) to keep the token cost of a large spec down. See [Environment variables](#environment-variables).
- **Generated tests check the contract, not just that code runs.** Each tool is called through a real MCP client (in-memory transport) with the API stubbed, and its test asserts the exact HTTP request the spec defines: method, path, query (OpenAPI's default serialization), headers, auth, and body encoding. It also checks that the response reaches the agent unchanged, that API errors become tool errors, and that calls missing required inputs are rejected. The sandbox typechecks the server before running them. Injected bugs (wrong path, a dropped header or auth, a misencoded body, swallowed errors) all fail.
- **Tests are frozen during repair.** The repair loop may edit `src/**/*.ts` only: tests, `package.json`, and `tsconfig.json` are never offered to the model, and the parser rejects any other path. Every repair passes the same security scan as generated code before it is applied, and a run only counts as passing when at least one test reports a pass, so an edit can't win by making the suite run nothing.
- **Every internal LLM call is traced.** Each agent tool call (`propose_tool_descriptions_batch`, `repair_code`) is recorded as an audit event with token counts, and its cost rolls up into per-run and platform metrics — secrets redacted throughout.

## Architecture

| Layer | Tech | Notes |
| --- | --- | --- |
| Backend / orchestrator | **NestJS 11** | DI + guards map cleanly to the auth/authz and multi-stage layout |
| Frontend dashboard | **Next.js 15** (App Router), React 19, Tailwind v3 | Same-origin `/api/*` proxied to the backend (no CORS needed) |
| Database | **PostgreSQL 16** via **Prisma** | Projects, runs, tools, test results, repair attempts, audit log |
| Background jobs | **BullMQ + Redis** (optional) | Long-running generation/test/repair survive restarts; falls back to inline |
| Sandbox | **Docker**, prebuilt image | Dependencies baked into a content-hashed image; tests run with `--network none`, non-root, no capabilities, read-only mounts, resource caps |
| LLM | **Google Gemini / NVIDIA NIM** (OpenAI-compatible) or **Anthropic Claude** (official SDK), via `@unumcp/llm` | Provider-agnostic; free tiers auto-selected, Claude opt-in; optional, since the platform degrades gracefully without it |
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
  sandbox/        Docker sandbox: prebuilt dependency image, locked-down test runner, Vitest summary parser
  security-scan/  Secret redaction, static scan of generated code, prompt-injection detection
  llm/            Provider-agnostic LLM client (Gemini / NVIDIA NIM / Anthropic Claude): batched tool-description proposal + code repair
  db/             Prisma schema + generated client
```

> **Note on untracked docs:** `unuMCP_SRS.md`, `tasks.md`, and `CLAUDE.md` are intentionally git-ignored (local planning/spec docs). This README is the canonical project documentation; [ARCHITECTURE.md](ARCHITECTURE.md) covers the design: pipeline, key decisions, trust boundaries, and what the requirement tags in code comments mean.

## Prerequisites

- **Node.js ≥ 22.13** (required by pnpm 11.5.1)
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
#   (an LLM key — GEMINI_API_KEY or NVIDIA_API_KEY — and REDIS_URL are optional; see below)

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
| `JWT_SECRET` | **yes** | none: the API refuses to start without it | Signs/verifies auth tokens. At least 32 characters (`openssl rand -hex 32`) |
| `PORT` | no | `3001` | API listen port |
| `GEMINI_API_KEY` | no | — | Google Gemini key (free tier via AI Studio). Auto-selects the Gemini provider. `GOOGLE_API_KEY` also accepted |
| `GEMINI_MODEL` | no | `gemini-3.5-flash` | Gemini model id (via its OpenAI-compatible endpoint) |
| `NVIDIA_API_KEY` | no | — | NVIDIA NIM key. `NIM_API_KEY` also accepted |
| `NIM_MODEL` | no | `meta/llama-3.3-70b-instruct` | NIM model id (OpenAI-compatible chat) |
| `ANTHROPIC_API_KEY` | no | none | Anthropic key. Only used with `LLM_PROVIDER=anthropic`: it bills per token, so a key alone never selects it |
| `ANTHROPIC_MODEL` | no | `claude-haiku-4-5` | Claude model id, e.g. `claude-sonnet-5-5` or `claude-opus-5-5`. Cost appears in run metrics and `/metrics` |
| `LLM_PROVIDER` | no | auto | Force the provider: `gemini`, `nim`, or `anthropic`. Default auto-detects from whichever free-tier key is set (Gemini preferred); `anthropic` is never auto-selected. **No key ⇒ LLM features disabled** (deterministic fallback, no repair) |
| `LLM_DISABLED` | no | — | Set `true` to force-disable the LLM even with a key |
| `PROPOSAL_BATCH_SIZE` | no | `5` | Tools described per LLM call (batched proposal, P2-6) |
| `PROPOSAL_CONCURRENCY` | no | `3` | Description batches in flight at once |
| `REDIS_URL` | no | — | **Absent ⇒ jobs run inline.** Set to enable the durable BullMQ queue |
| `JOBS_INLINE` | no | — | Set `true` to force inline execution even with `REDIS_URL` |
| `JOB_ATTEMPTS` | no | `3` | BullMQ retry attempts per job |
| `JOB_CONCURRENCY` | no | `2` | Worker concurrency |
| `MAX_REPAIR_ATTEMPTS` | no | `2` | Bounded self-repair passes (each ≈ one LLM call + a full sandbox rerun) |
| `REPAIR_MAX_TOKENS` | no | `4096` | Token ceiling per repair pass |
| `SANDBOX_CONCURRENCY` | no | `1` | Sandbox runs (tests and repair reruns) allowed at once; further runs queue |
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
pnpm lint          # ESLint (typescript-eslint + React hooks) over the whole repo
```

Per package / app:

```bash
pnpm exec turbo run typecheck test --filter=@unumcp/llm
pnpm exec turbo run typecheck test build --filter=@unumcp/web
```

Notes:

- **The API test suite needs a Postgres with the schema applied** (it exercises real Prisma against `DATABASE_URL`). Bring up `docker compose` and run `prisma db push` first.
- The **real-Redis queue round-trip** test is opt-in: it only runs when `REDIS_URL` is set (the default suite runs jobs inline).
- The **real Docker sandbox** is covered by an opt-in suite: `RUN_SANDBOX_DOCKER_TESTS=1 pnpm --filter @unumcp/api exec vitest run tests/sandbox.security.e2e.test.ts` proves, from inside a container, that there is no network, no root, and no write access to the project or the image, plus timeout cleanup and log redaction. Other unit/e2e tests use an injectable fake sandbox so they don't require Docker. The first real run builds the sandbox image (`pnpm --filter @unumcp/sandbox build-image` pre-builds it).

## Observability

Two dependency-free surfaces (the JSON shapes are drop-in for a real shipper later):

- **Structured request logs + trace ids.** One JSON line per HTTP request (`requestId`, method, path, status, `durationMs`); errors carry a `correlationId` that links the client envelope to the server log.
- **Metrics** at `GET /metrics` (JWT-scoped to the caller): projects created, specs parsed, servers generated, generation success rate, test pass rate, average generation time, repair counts, failed sandbox runs, and **LLM cost** (`totalInputTokens` / `totalOutputTokens` / `totalEstimatedCostUsd`).
- **Per-call LLM trace (FR-031).** Every internal agent tool call is an `llm_tool_call` audit event carrying an input/output summary, token counts, latency, and any error — all secret-redacted. Proposal and repair token usage rolls up onto the `GenerationRun` and into the metrics cost (free-tier models estimate to `$0`; the price table is per-model).

## Security posture

- **Human approval gate** before any code is generated; high-risk tools (destructive verbs) are disabled by default.
- **Static security scan** of generated code and of every LLM repair before it is persisted or packaged: refuses injected secrets, exfiltration hosts, and `eval`/shell patterns. Code is read through the TypeScript parser, so documentation (comments, tool and field descriptions) isn't mistaken for behaviour; that agent-facing text gets its own check: the API's own docs links pass, other links are noted for review, and an instruction to send data to an outside host is refused (tool poisoning).
- **Locked-down sandbox, no install step**: every generated server declares the same dependency set, so it is baked into a prebuilt, content-hashed image and nothing is downloaded or installed at test time (a project declaring anything else is refused before any container starts). Tests run as the image's own Vitest (never a project `npm` script) with `--network none`, a non-root user, all capabilities dropped, `no-new-privileges`, CPU/memory/pid caps, a read-only root FS, and the project mounted read-only. Runs are serialized (`SANDBOX_CONCURRENCY`), and a timeout or cancel force-removes the container through the Docker daemon.
- **No default signing key**: the API will not boot without a `JWT_SECRET` of at least 32 characters.
- **Prompt-injection detection** on untrusted spec text feeding the LLM; the description prompt treats spec content as untrusted data.
- **Secret redaction** across logs, error envelopes, and persisted sandbox output.
- **Sanitized error responses**: a single exception filter returns a structured envelope with a correlation id; 5xx bodies are generic (details stay server-side).
- **Rate limiting** on the API (per-client, per-endpoint windows). Behind the same-host Next.js proxy the client address comes from `X-Forwarded-For`, which is trusted only from a loopback peer, so clients get separate buckets and can't spoof their address by calling the API directly.

## Deployment

The platform runs generated code in a **Docker sandbox**, so it needs a host with a real Docker daemon — managed PaaS free tiers that disallow Docker-in-Docker (Render/Railway) can't run the test stage. The included kit deploys the whole stack — API, web, Postgres, and the sandbox — onto **one small AWS box**, fully scripted and on-demand:

```bash
bash deploy/provision.sh        # launch + self-install an SSM-managed t4g.small (zero inbound ports)
bash deploy/manage.sh url       # print the free Cloudflare tunnel URL once it's up
bash deploy/manage.sh stop      # on-demand: stop when idle (billing drops to disk only)
bash deploy/manage.sh teardown  # delete everything ($0)
```

Postgres runs in a container, jobs run inline (no Redis), the LLM is Gemini's free tier, and the public URL is a free `*.trycloudflare.com` quick tunnel (no Cloudflare account, no open ports). Secrets are read from `apps/api/.env` and injected at launch only — never committed. Full runbook, costs, and the stable-URL upgrade: [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

## Operational notes

- **Jobs are opt-in durable.** With no `REDIS_URL`, generation/test/repair run inline in-request, which is fine for dev and CI. Set `REDIS_URL` to route them through BullMQ so they survive restarts. Either way, a boot-time reconciler settles anything a crash stranded: a generation run still `running` after 5 min fails, and a project stuck mid-test (then `SANDBOX_FAILED`, safe to retry) or mid-repair (then `TESTS_FAILED`) after 15 min is recovered with an audit event, so the pipeline never hangs.
- **The repair loop runs on the queue.** A clean test failure triggers up to `MAX_REPAIR_ATTEMPTS` passes (LLM fix → sandbox rerun). Only a fix whose rerun passes is saved; on exhaustion the project settles on `TESTS_FAILED` (never a silent success) with the generated code unchanged, and every attempt stays in the repair history. The user may still download that partial output: any download with warnings (tests failed, errored, or never ran; auth to configure) embeds a `WARNINGS.md` saying so.
- **The LLM is provider-agnostic.** Any OpenAI-compatible backend works behind one `LlmClient` seam. Set `GEMINI_API_KEY` (Google AI Studio free tier) or `NVIDIA_API_KEY` (NIM); the provider auto-selects, or force it with `LLM_PROVIDER`. Model ids churn (NIM catalog EOLs, new Gemini releases) — pin a model but be ready to swap `GEMINI_MODEL`/`NIM_MODEL`.
- **Local storage for MVP.** Artifacts are written under `STORAGE_DIR` (temp dir by default); the storage layer is abstracted so an object store can replace it without touching callers.
