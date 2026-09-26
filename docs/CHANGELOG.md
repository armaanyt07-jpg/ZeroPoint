# Changelog

## Step 1 - Project scaffolding

### What Changed
Repository skeleton, TypeScript/Vitest/ESLint/Wrangler configuration, `.gitignore`, SRS-aligned directory layout.

### Why
A typed, testable base that matches SRS section 15, and a `.gitignore` that keeps secrets (`.env*`, `.dev.vars`) out of git.

### How It Works
One root `package.json`; `@zeropoint/*` imports resolve to `packages/*/src` through TS `paths` (and matching Vitest aliases), so there is no build step between packages. Wrangler bundles the Worker with esbuild, which honours the same `paths`.

### Files Changed
`package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `pnpm-workspace.yaml` (pnpm build-script approvals only), `apps/worker/wrangler.toml`, `apps/worker/.dev.vars.example`.

### Important Concepts
- **V8 isolate / Workers runtime**: no Node built-ins; only Web APIs (`fetch`, `crypto.subtle`, `Request`/`Response`).
- **Secrets**: set via `wrangler secret put` or a git-ignored `.dev.vars`, never in `wrangler.toml`.

### How To Verify
`pnpm install && pnpm typecheck`

## Step 2 - Database schema

### What Changed
Migrations 001 (SRS schema verbatim), 002 (`tenant_provider_credentials`), 003 (row-level security).

### Why
Postgres is the system of record (SRS 4.1). Encrypted provider keys need a home (NFR-5.2), and Supabase tables are publicly reachable unless RLS is enabled.

### How It Works
002 stores `v1:<iv>:<ciphertext>` per `(tenant_id, provider)`. 003 enables RLS with no policies, so only the service-role key can read.

### Files Changed
`database/migrations/001_init.sql`, `002_tenant_provider_credentials.sql`, `003_enable_row_level_security.sql`, `database/README.md`.

### Important Concepts
- **Row Level Security**: Postgres per-row access rules; "enabled, no policies" means deny by default.

### How To Verify
Apply the three files in order in the Supabase SQL editor. (Not executed by the automated tests.)

## Step 3 - Shared packages (crypto, pricing, providers, types)

### What Changed
SHA-256 hashing, AES-256-GCM encrypt/decrypt, the cost formula, the `LLMProviderAdapter` interface, the OpenAI adapter, and a provider registry.

### Why
FR-1.3/FR-1.4 and NFR-5.2/5.6: hashing proxy keys, protecting provider keys at rest, and making providers pluggable.

### How It Works
The OpenAI adapter builds the upstream request from an allow-list of headers, sets `Authorization` to the provider key, and streams the body through. The registry maps `x-provider` values to adapters.

### Files Changed
`packages/types`, `packages/crypto`, `packages/pricing`, `packages/providers`.

### Important Concepts
- **Provider adapter**, **AES-GCM + AAD** (see `docs/PHASE_1.md` Concepts).

### How To Verify
`pnpm test tests/unit/crypto.test.ts tests/unit/openai-adapter.test.ts tests/unit/pricing.test.ts`

## Step 4 - Edge Worker pipeline

### What Changed
Router, request pipeline, authentication, user-status check, budget guardrail, credential resolution, forwarding, Redis and Supabase clients, cached directory, sanitized errors, telemetry.

### Why
Implements FR-1.1 to FR-1.4 and the SRS section 7 lifecycle (minus the circuit breaker).

### How It Works
`pipeline.ts` runs authenticate -> provider -> (user + spend in parallel) -> status -> budget -> credential -> forward. Any stage throws a `ZeroPointError`, which becomes the SRS JSON error. Redis is used as a read-through cache and for the spend counter; Redis failures fail open, database failures return 503.

### Files Changed
`apps/worker/src/*`.

### Important Concepts
Read-through cache, negative caching, fail-open vs fail-closed, error sanitization (see `docs/PHASE_1.md`).

### How To Verify
`pnpm build:check` bundles the Worker. `pnpm test tests/integration`.

## Step 5 - Tests, verification and docs

### What Changed
91 automated tests, a dev helper script, `docs/PHASE_1.md`, README.

### Why
Prove each Phase 1 acceptance criterion (SRS 17) and make the system runnable by hand.

### How It Works
Tests replace Redis, Postgres and the provider with in-memory fakes, so they check ZeroPoint's logic without network access. A separate smoke test ran the real Worker in `wrangler dev` against a local mock.

### Files Changed
`tests/**`, `scripts/dev-helper.ts`, `docs/*`, `README.md`.

### Important Concepts
- **Test doubles (fakes)**: in-memory stand-ins for external services.

### How To Verify
`pnpm check` (typecheck + lint + tests).

## Step 6 - Review remediation (Critical and Major issues)

### What Changed
Fixes for the Critical and Major findings in `docs/PHASE_1_REVIEW.md`: request accounting, response-header allow-list, numeric Redis values, Anthropic and Gemini adapters with path routing, parallel lookups, `ctx.waitUntil` cache writes, complete rejection metrics, and provider errors in the SRS error schema. One finding (PostgREST quoting) was deliberately not applied; see below.

### Why
- The metrics counted a failed request as both allowed and rejected, and missed 503/500/404/405.
- OpenAI response headers (`openai-organization`, `openai-project`) reached clients.
- A numeric Redis value would have been read as $0 spent.
- FR-1.4 requires Anthropic and Gemini, and the pre-flight path had three sequential Redis round trips.

### How It Works
- `pipeline.ts`: `requests_allowed` is recorded after the forward succeeds; `errorToResponse()` records `requests_rejected` for every error type and is reused by `router.ts` for 404/405/config errors.
- `proxy.ts`: response headers are copied from an allow-list; provider errors are parsed for `error.message`, redacted and re-wrapped as `{ error: { code, message } }`.
- `packages/providers`: `AnthropicAdapter` (`x-api-key`, `anthropic-version`) and `GeminiAdapter` (`x-goog-api-key`, strict model-path pattern, `?alt=` only). `ProviderRegistry.supportsPath()` drives routing.
- `pipeline.ts` starts the credential lookup at the same time as the user and spend lookups but awaits it only after the 403/429 checks.
- `Directory` hands cache writes to `ctx.waitUntil`, so they no longer delay responses.

### Files Changed
`apps/worker/src/{pipeline,proxy,router,index,deps,directory,credentials,redis,errors}.ts`, `packages/providers/src/{adapter,shared,openai,anthropic,gemini,registry,index}.ts`, `tests/**` (3 new files, helpers extended), `docs/PHASE_1.md`.

### Important Concepts
- **`ctx.waitUntil`**: runs work after the response is sent, keeping the Worker alive until it finishes.
- **Allow-list vs deny-list**: copy only known-safe headers instead of removing known-bad ones.
- **Error precedence**: a request is judged by policy (403, 429) before infrastructure lookups that only matter for forwarding.
- **PostgREST `eq.` values are raw text**: quoting is only for `in.(...)` / `or=(...)`. The review's suggested quoting would have made every user lookup miss, silently disabling per-user budgets and blocking, so it was not applied.

### How To Verify
`pnpm check` (typecheck + lint + 161 tests). `pnpm build:check` bundles the Worker.

## Step 7 - Minor review findings

### What Changed
`/health` hardened, a per-request `x-request-id`, OpenAI organization/project headers no longer forwarded from clients, and a migration adding non-negative budget constraints. The migrations are now executed by an automated test for the first time.

### Why
- `/health` answered any HTTP verb and reported "ok" even when the Worker had no secrets.
- Requests could not be correlated across logs and client reports (SRS `request_logs.request_id`).
- A client could choose which OpenAI org/project was billed.
- A negative budget would silently block a user or tenant.

### How It Works
- `router.ts` `health()`: GET/HEAD only; builds the dependencies (which validates the secrets, without network calls) and returns 200 or 503.
- `index.ts` creates a UUID per request and a `ConsoleTelemetry` stamped with it; `router.ts` `withRequestId()` sets the response header without touching the body, so streaming is unaffected. Client-sent `x-request-id` is ignored.
- `openai.ts` drops `openai-organization` / `openai-project` from the forwarded-header allow-list.
- `004_budget_non_negative_checks.sql` adds the two CHECK constraints. `tests/unit/migrations.test.ts` runs all migrations on PGlite (in-process PostgreSQL).

### Files Changed
`apps/worker/src/{router,index,pipeline,telemetry}.ts`, `packages/providers/src/openai.ts`, `database/migrations/004_budget_non_negative_checks.sql`, `database/README.md`, `tests/integration/minor-fixes.test.ts`, `tests/unit/migrations.test.ts`, dev dependency `@electric-sql/pglite`.

### Important Concepts
- **Readiness vs liveness**: this `/health` is a readiness check (is the service configured?), not a dependency probe.
- **Correlation ID**: one id stamped on the response and every log line for a request.
- **Additive migrations**: change a schema with a new numbered file, never by editing one that may already be applied.

### How To Verify
`pnpm check`, then `curl -i localhost:8787/health` and look for `x-request-id` on any proxy response.
