# Phase 4 Plan: Administrative Analytics Dashboard

Status: **approved** (scope and D1-D4 chosen by the project owner; D5-D12 resolved below). Source: `docs/ZeroPoint_SRS_v1.0.pdf`.

## Phase 4 Requirements

| ID | What the SRS says |
| --- | --- |
| FR-4.1 | Administrators generate proxy keys in `pk_live_<random_secret>` format. The complete key is shown once; only its SHA-256 digest is stored. Traceability: Dashboard + PostgreSQL, Critical. |
| FR-4.2 | The dashboard exposes spend-per-user charts, top spenders, request/token metrics and active circuit-breaker events (mockup: TOTAL SPEND / ACTIVE USERS / CIRCUITS OPEN, SPEND / USER, DAILY SPEND, TOP SPENDERS, CIRCUIT BREAKER EVENTS, `[Tenant ▼]`). Traceability: Next.js + PostgreSQL, High. |
| SRS 12 | Create tenants and configure governance policy; generate and revoke proxy keys; configure provider credentials; create/configure end-user budgets; view aggregate and user-level spending; view request volume and token consumption; view circuit-breaker events; configure webhook destinations; review operational failures. |
| SRS 14/15 | Next.js dashboard (Tailwind/shadcn) at `apps/dashboard/{app,components,lib}`. |
| NFR-5.2 | SHA-256 proxy keys, AES-256-GCM provider credentials, no prompt/output persistence, no credentials exposed to clients or logs, least-privilege administrative access. |
| SRS 17 (Phase 4) | Proxy keys are shown only once; only SHA-256 digests are persisted; the dashboard displays spending and circuit events; prompt/output text never appears in analytics storage. |
| SRS 18 | "Pricing changes -> versioned pricing configuration." |

## Owner Decisions (asked before planning)

1. **D1: Admin auth = Supabase Auth + `admins` allowlist.** Admins sign in by email (magic link). Only addresses in a new `admins` table are let in. Every admin can manage every tenant (operator console, matching the mockup's `[Tenant ▼]`).
2. **D2: Scope = all of SRS section 12** (plus FR-4.1/4.2). Replaces hand-seeding with `pnpm helper`.
3. **D3: Prices are editable in the dashboard** (new `model_prices` table, read by the Worker). Nothing is invented in code; `DEFAULT_PRICING` stays empty.
4. **D4: The dashboard deploys to Vercel** as its own project rooted at `apps/dashboard`.

## Decisions (not fully specified by the SRS)

5. **D5: All dashboard data access is server-side with the service-role key.** Pages are Server Components and mutations are Server Actions; each one calls `requireAdmin()` first (verified Supabase session whose confirmed email is in `admins`). The browser only ever holds the Supabase anon key and its own session cookie. RLS stays "deny all, no policies" (migration 003), so the anon/authenticated roles still cannot read any table even with a valid session. Writing RLS policies for admins was considered and rejected: encryption (D7) and key hashing must run on the server anyway, and one enforcement point (`requireAdmin()`) is easier to audit than a policy per table. `proxy.ts` only refreshes the session cookie; it is not the security boundary.
6. **D6: Proxy keys are generated in `packages/crypto`** (`generateProxyKey()`: `pk_live_` + 24 random bytes base64url, `key_prefix` = first 12 characters, the same format the dev helper already uses). The plaintext is returned once from the Server Action, shown once with a copy button, and never stored, logged or cached. Revoke sets `status='revoked'`, `revoked_at=now()`.
7. **D7: The dashboard holds `CREDENTIAL_ENCRYPTION_KEY`** (server-only env var on Vercel) to encrypt provider keys with the existing AES-256-GCM + `"<tenantId>:<provider>"` AAD scheme. The alternative (a Worker admin endpoint that encrypts) adds a new authenticated public surface to the data plane; sharing one secret between two server runtimes is the smaller risk. The plaintext provider key is write-only: the UI shows only "configured / updated at", never the value or ciphertext.
8. **D8: Mutations invalidate the Worker's Redis cache** (the dashboard gets the Upstash REST credentials). Without it, a revoked key keeps working for up to `CACHE_TTL_SECONDS` (60 s). After each write the dashboard `DEL`s the affected `cache:apikey:{hash}` (revoke, tenant policy change: every key of the tenant), `cache:enduser:{tenant}:{user}` (budget/status) and `cache:providercred:{tenant}:{provider}` (credential), plus `cache:pricing` (prices). The DB write is the source of truth; invalidation is best-effort. If it fails, the UI says so and the change still takes effect within 60 s.
9. **D9: Price lookup.** A new `model_prices` table (`provider`, `model`, `input_per_million_usd`, `output_per_million_usd`, `updated_at`, `UNIQUE(provider, model)`), global (not per tenant). The Worker loads the whole table through the `Directory` read-through cache (`cache:pricing`, 60 s) in the usage branch (`ctx.waitUntil`, off the client's path) and puts the cost into the usage event. Because the cost is fixed in the event, a queue retry after a price edit cannot charge Redis and Postgres differently. Matching: exact `model`, else the model with a trailing version suffix stripped (`-YYYY-MM-DD`, `-YYYYMMDD`, `-NNN`, `-latest`), so `gpt-4o-mini-2024-07-18` (what OpenAI reports) uses the `gpt-4o-mini` price, while `gpt-4o-mini` never falls back to `gpt-4o`. A price-table read failure is treated like "unpriced" (cost 0, `usage_source='unknown'`, logged), not retried. "Versioned pricing" (SRS 18): each `request_logs` row freezes the cost at settlement time, so editing a price never rewrites history; the table records `updated_at` per row.
10. **D10: Aggregates run as SQL functions** (`dashboard_summary`, `dashboard_daily_spend`, `dashboard_top_spenders`, plus `dashboard_unpriced_models` for D12), service-role only (same REVOKE/GRANT pattern as `settle_usage`), because PostgREST cannot `GROUP BY`. Default range: last 30 days. CIRCUITS OPEN = distinct users with a `circuit_breaker_events` row whose `expires_at > now()`; it relies on the best-effort audit write (docs/PHASE_3.md), so it can under-count.
11. **D11: `api_keys.last_used_at` is updated, throttled.** The Worker sets `lastused:{apiKeyId}` with `SET NX EX 300` and only on success issues one PATCH in `ctx.waitUntil`, so each key causes at most one DB write per 5 minutes and nothing is added to the request's latency. Best-effort: failures are counted, never surfaced.
12. **D12: "Review operational failures" is shown as what exists, not invented.** Failures today are telemetry and log lines (Workers Logs) plus dead-letter queues; nothing is in Postgres. The dashboard gets an Operations page listing what it *can* see (webhook URL configured or not, provider credentials missing per tenant, unpriced models seen in the last 30 days, circuits currently open) and links to Cloudflare for logs/DLQs. Persisting Worker failures to Postgres is deferred: during a Redis outage that would turn every request into a database write.

## Out of Scope (deferred)

Deleting tenants (cascades through every table; needs a confirm-and-export flow), manually closing a circuit, per-tenant OpenAI org/project, webhook signing secret, HALF_OPEN, fail-closed policy, persisted operational-failure log, Redis spend rehydration, multi-level budgets.

## Proposed Changes

New:
- `apps/dashboard/` (Next.js 16, React 19, Tailwind 4, shadcn/ui, Recharts via shadcn charts, `@supabase/ssr`, zod): `app/` (login, auth callback, tenant-scoped pages: overview, users, keys, providers, settings, operations; global pricing page), `components/`, `lib/` (`auth.ts` `requireAdmin`, `db.ts` service-role client, `cache.ts` Redis invalidation, `validation.ts`, `queries.ts`), `proxy.ts` (session refresh).
- `database/migrations/007_dashboard.sql`: `admins`, `model_prices` (both RLS on, no policies), the four aggregate functions (service-role only). No new index: every aggregate is a range scan on the existing `idx_request_logs_tenant_created`.
- `packages/crypto` `generateProxyKey()`; `packages/pricing` `normalizeModelName()` + suffix-aware `findPricing()`.
- Minimal `package.json` in each `packages/*` so the dashboard can depend on them as workspace packages; `pnpm-workspace.yaml` lists `apps/dashboard` and `packages/*`.
- `packages/schemas` (SRS 15 lists it): Redis cache-key builders, the supported-provider list and the `x-user-id` rule, shared by the Worker and the dashboard so they cannot drift.

Changed (Worker):
- `store.ts` `findModelPrices()`, `touchApiKey()`; `directory.ts` `getModelPrices()`; `streaming/usage-extractor.ts` cost from DB prices (falls back to the adapter's static table); `pipeline.ts`/`auth.ts` throttled `last_used_at`.
- `scripts/dev-helper.ts` uses `generateProxyKey()`; adds `add-admin <email>` printing the SQL for bootstrapping the first admin.

## File/Component Mapping

| Requirement | Files |
| --- | --- |
| FR-4.1 keys | `packages/crypto` `generateProxyKey`, `apps/dashboard/app/(admin)/t/[tenantId]/keys`, `lib/cache.ts` |
| FR-4.2 analytics | migration 007 functions, `lib/queries.ts`, `app/(admin)/t/[tenantId]/page.tsx`, `components/charts/*` |
| SRS 12 tenants/policy/webhook | `app/(admin)/tenants/new`, `t/[tenantId]/settings` |
| SRS 12 provider credentials | `t/[tenantId]/providers`, `packages/crypto` `encryptSecret` |
| SRS 12 end-user budgets | `t/[tenantId]/users` |
| SRS 12 operational failures | `t/[tenantId]/operations` (D12) |
| Prices (D3/D9) | migration 007 `model_prices`, `app/(admin)/pricing`, Worker `store.ts`/`directory.ts`/`usage-extractor.ts` |
| Admin auth (D1/D5) | migration 007 `admins`, `lib/auth.ts`, `proxy.ts`, `app/login`, `app/auth/callback` |

## Testing Strategy

Root vitest (unchanged runner): `generateProxyKey` format/entropy/prefix; `findPricing` suffix rules (dated snapshots match, `gpt-4o-mini` never matches `gpt-4o`); dashboard validation schemas (policy bounds, https-only webhook URLs, budget >= 0, price >= 0, provider id allow-list); `requireAdmin` (no session / unconfirmed email / not allowlisted / allowlisted); cache-invalidation key builders match the Worker's (imported from the same constants, not copied); migration 007 on PGlite (aggregates over seeded logs, range boundaries, open-circuit count, REVOKE on functions); Worker: DB price used when present, suffix match, price-read failure -> unpriced, `last_used_at` throttled to one write per window and never blocks the response.

Dashboard: `next build` + typecheck in `pnpm check`; manual end-to-end against a Supabase project (login, create tenant, key once, revoke takes effect immediately, credential, budget, price -> spend appears in charts).

## Risks

The dashboard server holds the most powerful secrets in the system (service-role key, encryption key, Redis token): a bug that skips `requireAdmin()` in one Server Action exposes everything, so every action goes through one wrapper (`adminAction`) and a test asserts each exported action is wrapped. Magic-link login depends on Supabase email delivery and the Site URL / redirect allow-list being set correctly. Prices are entered by hand and wrong prices silently mis-charge (the UI shows per-million prices and an example cost to make mistakes visible).
