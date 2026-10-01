# unuMCP architecture

How unuMCP turns an OpenAPI spec into a tested MCP server, why it is built this
way, and where each kind of untrusted input is contained. The README covers
setup and usage; this document covers design.

## The pipeline

A `Project` moves through one pipeline with a single human gate. Every stage
writes its state to Postgres and an `AuditEvent`, so a run can be inspected,
resumed, or recovered after a crash.

```
upload spec ─► validate + dereference ─► extract endpoints ─► propose tools
                                                                   │
                         ┌─────────────── human approval ◄─────────┘
                         ▼
                 generate server ─► security scan ─► sandbox tests ─┬─► complete ─► ZIP
                                                                    │
                                                  failed tests ─► bounded repair
```

| Stage | Where | What it guarantees |
| --- | --- | --- |
| Parse and validate | `packages/openapi` (`validate.ts`) | JSON or YAML OpenAPI 3.x; Swagger 2.0 is refused with conversion advice rather than misread |
| Dereference | `packages/openapi` (`dereference.ts`) | No `$ref` left; cycles kept as object cycles that every later walk guards against |
| Extract | `packages/openapi` (`extract.ts`) | One record per operation: parameters, request body (JSON, `+json`, or form; anything else reported), auth, deprecation |
| Propose | `packages/analysis` | Deterministic name (from `operationId`), risk level, input schema; high-risk, deprecated, and unsendable endpoints start disabled |
| Describe | `packages/llm`, `apps/api/src/tools` | Optional LLM-written descriptions, batched; spec text is treated as data |
| Approve | `apps/api/src/tools` | A person chooses the final tool set; names stay unique |
| Generate | `packages/codegen`, `packages/schema-gen` | A complete TypeScript MCP server, byte-identical for the same inputs |
| Scan | `packages/security-scan` | Refuses secrets, foreign hosts in code, eval or shell use, disallowed dependencies |
| Test | `packages/sandbox`, `apps/api/src/testing` | A typecheck, then the server's contract tests, in a locked-down, offline container |
| Repair | `apps/api/src/repair`, `packages/llm` | Bounded LLM fixes to implementation files only; saved only when tests pass |
| Package | `apps/api/src/generation` | Deterministic ZIP; a `WARNINGS.md` whenever anything is untested or failing |

## Code layout

```
packages/        pure, IO-free domain logic (unit-tested without a database or Docker)
  openapi/         parse, validate, dereference, extract, detect auth
  analysis/        classify endpoints, score risk, name tools, assemble input schemas
  schema-gen/      JSON Schema to Zod source
  codegen/         the generated server's files
  security-scan/   static scan, secret redaction, prompt-injection flags
  sandbox/         sandbox image definition, container arguments, test verdict
  llm/             provider-agnostic LLM client (Gemini, NVIDIA NIM, Anthropic)
  db/              Prisma schema and client
apps/
  api/             NestJS shell: HTTP, auth, persistence, jobs, orchestration
  web/             Next.js dashboard, talking to the API through a same-origin proxy
```

Dependencies point inward: `apps/*` use `packages/*`, never the reverse, and
the packages only depend on each other where the pipeline does (for example
`codegen` uses `schema-gen`). Side effects (database, files, Docker, network)
live in `apps/api` behind injectable seams (`SandboxRunner`, `LlmClient`,
`StorageService`), which is what lets the orchestration be tested with fakes.

## Key decisions

**Determinism first, LLM last.** Everything structural (names, schemas, code,
tests, the ZIP) is produced by plain functions of their input. The LLM writes
only prose (tool descriptions) and repair edits, and the pipeline works end to
end with the LLM switched off. This makes output reproducible, reviewable, and
cheap.

**One human gate.** Tool proposal is automatic, but nothing is generated until
a person approves the tool set. Risky tools are visible and off by default
instead of silently included.

**A sandbox with no install step.** Every generated server declares the same
dependency set, so those dependencies are baked into a prebuilt image tagged by
a hash of its definition (`packages/sandbox/src/image.ts`). Test runs download
nothing and never execute a project-controlled script: the image's own Vitest
runs the tests with no network, a non-root user, all capabilities dropped, no
privilege escalation, CPU/memory/pid caps, a read-only root filesystem, and the
project mounted read-only. A project declaring any other dependency is refused
before a container starts, and a drift test keeps the image in step with the
code generator. Runs are serialized process-wide (`SANDBOX_CONCURRENCY`).

**A pass means a test passed.** A clean exit is not enough: at least one test
must report passing (`packages/sandbox/src/verdict.ts`), so a harness that runs
nothing can never turn a project green.

**Repair can't cheat or ship worse code.** The repair loop may edit only
`src/**/*.ts` (tests, `package.json`, and config are never offered to the
model), every edit is security-scanned before it is applied, and attempts run
on a working copy. Stored code changes only when an attempt's rerun passes; if
the loop gives up, the generated code ships unchanged with a warning.

**The scan reads code, not text.** Behavioural rules (foreign hosts, eval and
shell use, obfuscation) run on a parser-backed view of each source file with
comments and documentation strings blanked out, so a docs link in a schema
description is not mistaken for a network call. That documentation is still
checked on its own, because MCP clients hand it to the agent: links to the
API's own site pass, links elsewhere are noted for review, and text telling the
agent to send data to an outside host is refused as tool poisoning. Secret
patterns apply to every byte, and a file that doesn't parse is scanned raw.

**Providers are a seam.** `LlmClient` has one method. Gemini and NIM speak the
OpenAI-compatible API; Anthropic uses its official SDK. Free tiers are
auto-selected; the paid provider needs an explicit `LLM_PROVIDER=anthropic`.
Every call is recorded as an audit event with tokens and estimated cost.

**Jobs are durable when it matters.** With `REDIS_URL` set, generation and
testing run on a BullMQ queue; without it they run inline (fine for one box).
Either way, a boot-time reconciler settles anything a crash stranded.

## Trust boundaries

| Untrusted input | Contained by |
| --- | --- |
| The uploaded spec (names, descriptions, URLs, schemas) | Size limits; every spec-derived string reaches generated code only through `JSON.stringify`; names sanitized to snake_case; descriptions flagged for prompt-injection patterns and given to the LLM as data |
| LLM output (descriptions, repair edits) | Descriptions checked for secret-shaped text; repair edits limited to an allowlist of files, parsed strictly, security-scanned, and kept only if tests pass |
| Generated code at test time | The locked-down, offline sandbox container, with a timeout that removes the container itself |
| API clients | JWT auth (the API refuses to start without a strong secret), per-project ownership checks returning 404, per-client rate limits behind the trusted local proxy, one sanitized error envelope |
| Logs and stored output | Secret redaction before anything is persisted or shown |

## Data model

`User` owns `Project`s. A project has `ApiSpec` uploads (the latest valid one
drives the pipeline), the `Endpoint`s extracted from it, `ToolCandidate`s
(linked to endpoints through `ToolEndpoint`), and `GenerationRun`s. A run owns
its `GeneratedArtifact`s (content-hashed files in storage), its `TestResult`s
(test-stage runs and repair reruns, told apart by suite), and its
`RepairAttempt`s (diff, failure, outcome). `AuditEvent` records every
transition and every LLM call. See `packages/db/prisma/schema.prisma`.

## Testing

The platform's own tests:

- Packages are unit-tested without a database or Docker (pure functions, faked
  `docker` for the sandbox lifecycle).
- `apps/api` end-to-end tests run the real NestJS app against Postgres with a
  fake sandbox and a fake LLM.
- Opt-in suites exercise the real Docker sandbox (proving its confinement from
  inside a container, and that generated servers pass their contract tests and
  fail them when broken) and the real Redis queue.
- CI runs lint, typecheck, and every test against Postgres on each push.

The tests generated with each server are contract tests
(`packages/codegen/src/contract.ts`). For every tool, the generator derives
example arguments and the HTTP request the spec says they must produce, using
rules independent of the generated handler: the path template filled and
percent-encoded, query values in OpenAPI's default serialization (arrays get
two items, so "repeat the key" can't pass for "join the values"), header
inputs, the auth header, and the body in its media type. The test calls the
tool through a real MCP client connected in memory, with `fetch` stubbed, and
compares. It also checks that the response reaches the agent unchanged, that
an API error becomes a tool error, and that a call missing required inputs is
rejected without reaching the API. A server-level test checks the tool listing.
In the sandbox, `tsc --noEmit` runs first, since Vitest only strips types.

## Reading the code: requirement tags

Comments cite tags such as `FR-031`, `NFR-007b`, `OD-1`, `P6-7`, or `§16.4`.
They trace code back to an internal specification and build plan that are not
published:

| Tag | Meaning |
| --- | --- |
| `FR-n` | A functional requirement |
| `NFR-n` | A non-functional requirement (security, cost, reliability, ...) |
| `OD-n` | An open design decision, settled by a spike before building on it |
| `Pn-m` | Task m of build phase n |
| `§n.m` | A section of the internal specification |

They are traceability for the maintainer, not prerequisites for the reader:
the code, its comments, and this document are meant to stand on their own.
