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

## Step 8 - Phase 2 plan
### What Changed
`docs/PHASE_2_PLAN.md`: the SRS Phase 2 requirements mapped to files, data flow, risks and deferred work, with decisions D1-D6 resolved.
### Why
Phase 2 touches the request path, Redis, a queue and two schema changes; the scope and the boundary with Phases 3/4 were fixed before any code changed.
### Files Changed
`docs/PHASE_2_PLAN.md`.
### How To Verify
Read it against `docs/ZeroPoint_SRS_v1.0.pdf` sections 3 (Phase 2), 8-11, 17.

## Step 9 - Dual-stream parsing (FR-2.1, FR-2.2)
### What Changed
`tee()` on successful provider responses, an incremental SSE decoder, per-provider usage extraction, cost calculation, a price table (empty on purpose), and the OpenAI streaming usage opt-in.
### Why
The client must get the stream with no added buffering while ZeroPoint reads token usage on the side (SRS 2.3, NFR-5.1).
### How It Works
- `proxy.ts` `passThrough()`: when a usage context is supplied, `upstream.body.tee()`; branch A is the client `Response`, branch B goes to `trackUsage` under `ctx.waitUntil`.
- `SseParser` (`packages/providers/src/sse-parser.ts`): `TextDecoder({stream:true})`, `\n`/`\r\n`/`\r`, multi-line `data:`, comments, an unterminated final frame delivered by `end()`, bounded buffer.
- Adapters implement `extractUsage(json)`; `mergeUsage` keeps the latest cumulative value per field; frames without `"usage` skip `JSON.parse`.
- JSON (non-streaming) bodies are buffered up to 2 MiB and parsed once (D1). OpenAI `stream:true` requests get `stream_options.include_usage` (D2).
- `packages/pricing` gets `DEFAULT_PRICING = []` (the SRS has no price values; unpriced -> cost 0, `usage_source = 'unknown'`) and 8-decimal rounding.
### Files Changed
`apps/worker/src/{proxy,pipeline,deps,telemetry}.ts`, `apps/worker/src/streaming/*`, `packages/providers/src/*`, `packages/pricing`, `packages/types`.
### Important Concepts
`ReadableStream.tee()`, incremental decoding, cumulative usage (see `docs/PHASE_2.md`).
### How To Verify
`pnpm test tests/unit/sse-parser.test.ts tests/unit/usage-extraction.test.ts tests/unit/openai-stream-optin.test.ts tests/integration/streaming.test.ts`

## Step 10 - Queue settlement (FR-2.3, FR-2.4)
### What Changed
A Cloudflare Queue producer and consumer, atomic idempotent Redis settlement, an idempotent Postgres function, migration 005, and queue bindings.
### Why
Spend must be recorded without adding latency to the user's request, and a redelivered message must never charge twice.
### How It Works
- The request path sends a metadata-only `UsageEvent` (3 attempts with backoff, off the client path).
- The Worker's `queue()` handler runs `settlement.ts`: a Lua `EVAL` (`SET settled:{request_id} NX`, then `INCRBYFLOAT spend:{tenant}:{user}`) and then the `settle_usage()` RPC (upsert user, `INSERT request_logs ... ON CONFLICT DO NOTHING`, add cost only if inserted). Each half is idempotent alone. Failures retry with backoff; after 10 attempts a message goes to the dead-letter queue.
- Migration 005 widens `end_users.current_spend_usd` to `NUMERIC(14,8)` and restricts `settle_usage` to the service role.
### Files Changed
`apps/worker/src/{settlement,usage-queue,redis,store,env,index,deps}.ts`, `apps/worker/wrangler.toml`, `database/migrations/005_settlement.sql`, `database/README.md`.
### Important Concepts
At-least-once delivery, idempotency keys, atomic Lua scripts, dead-letter queues, function privileges in Postgres.
### How To Verify
`pnpm test tests/unit/settlement.test.ts tests/unit/migrations.test.ts`. Deploy: `wrangler queues create zeropoint-usage` and `zeropoint-usage-dlq`, apply migration 005, then deploy.

## Step 11 - Phase 2 tests and verification
### What Changed
131 new tests (318 total), a Lua VM (`fengari`, dev dependency) so the real settlement script is executed in tests, `docs/PHASE_2.md`, README status.
### Why
Every new behaviour needed a test that fails when the behaviour breaks; each core behaviour was mutation-checked.
### How It Works
See the Tests section of `docs/PHASE_2.md`. A throwaway `wrangler dev` harness confirmed incremental delivery, queue delivery, settlement and disconnect handling in the real Workers runtime.
### Files Changed
`tests/**`, `package.json` (`fengari`), `docs/PHASE_2.md`, `docs/CHANGELOG.md`, `README.md`.
### How To Verify
`pnpm check` and `pnpm build:check`.

## Step 12 - Phase 3 plan
### What Changed
`docs/PHASE_3_PLAN.md`: the SRS Phase 3 requirements mapped to files, where velocity vs. loop detection each run in the request lifecycle, and decisions D1-D7.
### Why
Phase 3 changes the request pipeline's control flow (a new 429 path before budget/forward), adds a second Cloudflare Queue, and needed a schema decision (a new audit table) before any code changed.
### Files Changed
`docs/PHASE_3_PLAN.md`.
### How To Verify
Read it against `docs/ZeroPoint_SRS_v1.0.pdf` sections 3 (Phase 3), 6.4, 7, 10-13.

## Step 13 - Circuit breaker (FR-3.1-3.5, FR-3.7)
### What Changed
Velocity tracking (Redis sorted sets) and pattern-hash loop detection (Redis lists), both as atomic Lua scripts; the circuit state check wired into the request pipeline before budget and before the provider; a second queue and consumer for developer webhooks; a new audit table.
### Why
A runaway agent loop must be stopped by dollars-per-minute (an agent calling an expensive model repeatedly) and by exact-repeat pattern (an agent stuck retrying the identical call), and the tenant needs to be told without that notification ever slowing down or failing a request.
### How It Works
- `circuit-breaker.ts`: `VELOCITY_SCRIPT` (`ZADD`/`ZREMRANGEBYSCORE`/sum/threshold, guarded by an `EXISTS` check so an open circuit is never re-tripped) and `HASH_SCRIPT` (`LPUSH`/`LTRIM` to 5/last-3-equal, same guard). Circuit value is `"<reason>:<expiresAtMs>"` — no `cjson`, so the exact script text can run inside a plain Lua VM in tests.
- `pipeline.ts`: circuit state is read in the same parallel batch as end-user/spend (step 3); an OPEN circuit 429s before budget (step 5). After budget passes, the request body is hashed from a `Request.clone()` (step 7); three consecutive matches 429 this request too, and defer the audit write + webhook.
- `settlement.ts`: after a newly-settled usage event, `checkVelocity` runs against the tenant's window/threshold; a trip records the event and queues a webhook, same code path (`recordAndNotify`) the pipeline's loop trip uses.
- `webhook-queue.ts`/`webhook-dispatch.ts`: a `WEBHOOK_QUEUE` binding, retried with backoff like the usage queue, POSTing `{event, tenant_id, external_user_id, reason, opened_at, expires_at}` to `tenants.webhook_url`.
- `store.ts`: `findApiKeyByHash`'s embedded `tenants(...)` select grows to include `velocity_limit_usd`/`velocity_window_seconds`/`circuit_breaker_duration_seconds`/`webhook_url` (all already in the SRS schema, unused until now); `findTenantPolicy` for settlement (no API key there); `recordCircuitBreakerEvent` (best-effort insert).
- Migration 006: `circuit_breaker_events` (additive, not in SRS 4.3).
### Files Changed
`apps/worker/src/{circuit-breaker,webhook-queue,webhook-dispatch,pipeline,settlement,store,auth,deps,env,index,errors}.ts`, `apps/worker/wrangler.toml`, `database/migrations/006_circuit_breaker.sql`, `database/README.md`, `packages/types`.
### Important Concepts
Redis sorted sets as a sliding window, atomic Lua scripts as a full read-decide-write, `Request.clone()` for a second independent body read (and the `cancel()`-must-not-be-awaited gotcha it shares with Phase 2's `tee()`).
### How To Verify
`pnpm test tests/unit/circuit-breaker.test.ts tests/unit/webhook-queue.test.ts tests/unit/webhook-dispatch.test.ts tests/integration/circuit-breaker.test.ts`

## Step 14 - Phase 3 tests and verification
### What Changed
67 new tests (385 total), the test Lua-VM shim extended with sorted-set/list commands so the real `VELOCITY_SCRIPT`/`HASH_SCRIPT` execute in tests, `docs/PHASE_3.md`, README status.
### Why
Same principle as Phase 2's Step 11: every new behaviour needed a test that fails when it breaks, and the shipped Lua text is what gets executed, not a JS re-implementation of it.
### How It Works
See the Tests section of `docs/PHASE_3.md`. Two real bugs were caught this way: an inclusive-range off-by-one in the test Lua shim that under-counted the velocity sum by one entry, and a hang from awaiting `cancel()` on a cloned request's body reader before its sibling branch was drained.
### Files Changed
`tests/**`, `docs/PHASE_3.md`, `docs/CHANGELOG.md`, `README.md`, `database/README.md`.
### How To Verify
`pnpm check` and `pnpm build:check`.

## Step 15 - Phase 4 plan
### What Changed
`docs/PHASE_4_PLAN.md`: FR-4.1/4.2 and SRS section 12 mapped to files, with the owner's four choices (admin auth, scope, pricing, hosting) and decisions D5-D12.
### Why
Phase 4 adds a second application with its own security boundary, shares secrets with the Worker, and changes how the Worker prices requests. All of that needed agreeing before code.
### Files Changed
`docs/PHASE_4_PLAN.md`.
### How To Verify
Read it against `docs/ZeroPoint_SRS_v1.0.pdf` sections 3 (Phase 4), 12, 14, 15 and 17.

## Step 16 - Shared packages, migration 007 and Worker changes
### What Changed
- `packages/schemas` (new): Redis cache-key builders, the supported-provider list, and the `x-user-id` rule.
- `generateProxyKey()` in `packages/crypto`.
- Dated-snapshot price matching in `packages/pricing`.
- Migration 007: `admins`, `model_prices`, and four `dashboard_*` aggregate functions (service-role only).
- The Worker prices usage from `model_prices` and records `api_keys.last_used_at`, throttled.
### Why
- Without prices every request costs $0, so budgets and the velocity breaker can never trip.
- Prices had to be editable without a redeploy (owner decision D3).
- The dashboard must invalidate exactly the cache keys the Worker reads, so both import one definition.
### How It Works
- `usage-extractor.ts` loads the price table through the `Directory` cache (`cache:pricing`, 60 s), only when there is usage to price. It fixes the cost into the usage event, so a queue retry after a price edit cannot charge Redis and Postgres differently. A failed price read records the request as unpriced rather than dropping it.
- `findPricing` tries an exact match, then the model with its version suffix stripped. So `gpt-4o-mini-2024-07-18` uses the `gpt-4o-mini` price, and `gpt-4o-mini` never falls back to `gpt-4o`.
- `recordKeyUse` (`auth.ts`) runs under `waitUntil`. A Lua `SET NX EX 300` allows at most one `PATCH api_keys` per key per 5 minutes. When Redis is down it skips the write instead of writing on every request.
- Every `packages/*` got a minimal `package.json` so the dashboard can depend on them. The Worker still resolves them through TS paths, as before.
### Files Changed
`packages/{schemas,crypto,pricing}/**`, `packages/*/package.json`, `pnpm-workspace.yaml`, `database/migrations/007_dashboard.sql`, `apps/worker/src/{auth,pipeline,store,directory,deps}.ts`, `apps/worker/src/streaming/usage-extractor.ts`, `scripts/dev-helper.ts` (`add-admin`, shared key generator), `tsconfig.json`, `vitest.config.ts`.
### Important Concepts
Read-through caching of a whole small table; freezing a derived value (cost) at the moment it is computed so retries stay consistent; throttling writes with an atomic Redis `SET NX EX`.
### How To Verify
`pnpm test tests/unit/migrations.test.ts tests/unit/pricing.test.ts tests/unit/crypto.test.ts tests/integration/dashboard-worker.test.ts`

## Step 17 - Admin dashboard (FR-4.1, FR-4.2, SRS 12)
### What Changed
`apps/dashboard`: Next.js 16, React 19, Tailwind 4 and shadcn/ui, deployed to Vercel. It has these pages:
- Sign-in by magic link.
- Tenants, and a new-tenant form.
- Per tenant: Overview (stat tiles, daily spend chart, spend-per-user chart, top spenders, circuit-breaker events), Users & budgets, Proxy keys, Provider credentials, Settings, Operations.
- Model prices (global).
### Why
SRS Phase 4 and section 12. It replaces hand-seeding the database with `pnpm helper` and SQL.
### How It Works
- Pages read through `getAdminDb()`, the admin check plus the service-role client.
- Writes go through `adminAction()`, which runs the admin check, then zod validation, then the handler, then an audit log line.
- Admin = a confirmed Supabase Auth email that appears in `admins`.
- After each write, the dashboard deletes the Worker's matching Redis cache entries.
- Keys are shown once, and only their SHA-256 is stored. Provider keys are encrypted with the Worker's AES-GCM key and AAD.
- Charts follow the dataviz method: one validated hue, thin marks, a table view, and hover tooltips.
### Files Changed
`apps/dashboard/**`, root `package.json` (`dashboard`, `dashboard:build`; `typecheck`/`lint` include the dashboard), `eslint.config.js`, `tests/server-only-stub.ts`.
### Important Concepts
Server Actions as public endpoints; Data Access Layer; show-once secrets; React 19 form reset (D14); feedback for a form that the action's own re-render unmounts (D15).
### How To Verify
`pnpm dashboard` with `apps/dashboard/.env.local` (see `.env.example`), then sign in with an allowlisted email.

## Step 18 - Phase 4 tests and verification
### What Changed
63 new tests (448 total), `docs/PHASE_4.md`, README.
### Why
The dashboard concentrates the most powerful secrets. The tests pin the admin check (including a static check that every action is wrapped), the input rules, and the SQL aggregates. An end-to-end run exercised the real schema through PostgREST.
### How It Works
See the Tests section of `docs/PHASE_4.md`. The end-to-end run found two real bugs and fixed them: a failed submit erased the form (React 19 form reset), and revoking a key showed no confirmation because the form unmounted before its effect ran. It also caught chart axis ticks that all read "$0".
### Files Changed
`tests/**`, `apps/dashboard/tests/**`, `docs/PHASE_4.md`, `docs/CHANGELOG.md`, `README.md`, `database/README.md`.
### How To Verify
`pnpm check`, `pnpm build:check` and `pnpm dashboard:build`.
