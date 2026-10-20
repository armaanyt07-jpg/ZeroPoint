# Phase 4

## Objective
Administrative Analytics Dashboard (SRS section 3, Phase 4, and section 12). A Next.js app at `apps/dashboard` where allowlisted administrators sign in, then:
- create tenants and set their governance policy
- generate and revoke proxy keys (FR-4.1)
- store provider credentials
- set end-user budgets and block users
- configure webhooks
- enter model prices
- see spend, request, token and circuit-breaker analytics (FR-4.2)

The Worker gained two small features: it now prices requests from the dashboard's price table, and it records `api_keys.last_used_at`. Approved plan: `docs/PHASE_4_PLAN.md`.

## SRS Requirements
| ID | Requirement (summary) |
| --- | --- |
| FR-4.1 | Generate `pk_live_<random_secret>` keys; show the full key once; store only its SHA-256 digest |
| FR-4.2 | Spend-per-user charts, top spenders, request/token metrics, active circuit-breaker events |
| SRS 12 | Tenants + policy, key generate/revoke, provider credentials, end-user budgets, aggregate and per-user spend, request/token volume, circuit-breaker events, webhook destinations, operational failures |
| SRS 14/15 | Next.js + Tailwind/shadcn dashboard at `apps/dashboard/{app,components,lib}` |
| NFR-5.2 | SHA-256 keys, AES-256-GCM credentials, no prompt/output persistence, no credentials to clients or logs, least-privilege admin access |
| SRS 17 (Phase 4) | Keys shown once; only digests persisted; dashboard shows spending and circuit events; no prompt/output text in analytics storage |
| SRS 18 | Pricing changes -> versioned pricing configuration |

## Architecture
```
Admin browser --magic link--> Supabase Auth (identity)
      |  session cookie (anon key; can read NO table: RLS deny-all)
      v
Next.js on Vercel (apps/dashboard)
  proxy.ts              refreshes the session cookie only (not a security boundary)
  every page            getAdminDb()  = requireAdmin() + service-role client
  every Server Action   adminAction() = requireAdmin() -> zod validate -> run -> audit log
  requireAdmin()        Supabase getUser() + confirmed email + row in `admins`
      |                          |                                  |
      v                          v                                  v
  Supabase Postgres         Upstash Redis                   (nothing else)
  tenants, api_keys,        DEL cache:* entries after a change, so the Worker sees
  end_users, model_prices,  revocations/blocks/prices on the next request (D8)
  dashboard_* SQL functions

Worker (changed):
  pipeline: after auth -> defer recordKeyUse (SET NX lastused:{key} EX 300 -> PATCH api_keys.last_used_at)
  usage branch: needs a price? -> Directory.getModelPrices (cache:pricing, 60 s) -> cost frozen into the usage event
```
Key files:
- Dashboard core: `apps/dashboard/lib/{auth,authz,action,action-core,validation,queries,cache,env,format}.ts` and `apps/dashboard/lib/supabase/server.ts`.
- Dashboard pages and actions: `apps/dashboard/app/(admin)/**`, plus `app/login` and `app/auth/callback`.
- Database: `database/migrations/007_dashboard.sql`.
- Shared packages: `packages/schemas` (new), `packages/crypto/src/proxy-key.ts`, `packages/pricing` (snapshot matching).
- Worker: `apps/worker/src/{auth,pipeline,store,directory,deps}.ts` and `streaming/usage-extractor.ts`.

### Concepts introduced
- **Authentication vs. authorization, split across two systems**: Supabase Auth proves who an admin is (an email they control). The `admins` table decides whether that person may enter. `decideAdmin()` (lib/authz.ts) is the whole rule, kept free of framework imports so it is unit-tested: no session, unconfirmed email, not allowlisted, or allowed.
- **Data Access Layer**: pages never create a database client directly. They call `getAdminDb()`, which runs the admin check first. A layout's check is not enough: Next.js keeps layouts across client-side navigations, so a layout cannot be the security boundary.
- **Server Actions are public endpoints**: anyone can POST to an action without the UI. So every action is built with `adminAction()`, which checks the admin *before* it parses input. A test reads every `"use server"` file and fails if an export isn't built that way.
- **Show-once secrets**: a new proxy key exists only in the Server Action's return value and in one dialog's React state. Closing the dialog drops it. The database holds `sha256(key)` and a 12-character prefix for recognition.
- **Cache invalidation across systems**: the Worker caches keys, users, credentials and prices in Redis for 60 s (Phase 1). The dashboard writes to Postgres first (the source of truth), then deletes the matching cache entries, using key builders shared from `packages/schemas`. If the delete fails, the change still applies within 60 s, and the admin is told so.

## Decisions (not fully specified by the SRS)
See `docs/PHASE_4_PLAN.md` for D1-D12, decided before implementation:
- D1-D4, chosen by the owner: Supabase Auth with an allowlist, all of SRS section 12, editable prices, Vercel hosting.
- D5: server-side data access with the service-role key.
- D6: keys generated in `packages/crypto`.
- D7: the dashboard holds the encryption key.
- D8: cache invalidation.
- D9: price lookup with dated-snapshot matching.
- D10: aggregates as SQL functions.
- D11: throttled `last_used_at`.
- D12: Operations shows only the data that actually exists.

Decided during implementation:

13. **D13: Cache Components is turned off** (`next.config.ts`). Next.js 16's `create-next-app` enables it. With it on, every page that reads the session must stream behind Suspense with explicit cache rules. Every page here is per-admin live data with nothing worth caching, so the classic per-request rendering is simpler and always fresh.
14. **D14: Forms submit through `onSubmit` + `startTransition`, not `<form action>`.** React 19 resets a form after a form action runs. On a validation error, that would erase what the admin typed. Caught by the end-to-end run ("typed values survive a failed submit").
15. **D15: Action feedback fires when the action settles, not from an effect.** The action's response re-renders the page, and that often removes the form that submitted it: a revoked key loses its Revoke button, a deleted price loses its row. An effect in an unmounted form never runs, so revoking showed no confirmation at all. Caught by the end-to-end run.
16. **D16: Webhook URLs must be `https://` with no embedded credentials.** The payload names blocked users. Payloads are still unsigned; that is a Phase 3 known limitation.
17. **D17: The magic link is only sent to allowlisted addresses, and the reply is identical either way.** Strangers cannot create Supabase accounts, and the form doesn't reveal who is an admin. The callback only ever redirects to `/`, so it can't be used as an open redirect.

## Implementation Status
Deferred:
- Deleting tenants: it cascades through every table, so it needs a confirm-and-export flow.
- Manually closing a circuit.
- Per-tenant OpenAI org/project settings.
- A webhook signing secret.
- `HALF_OPEN` and a fail-closed policy.
- A persisted operational-failure log (D12).
- Redis spend rehydration.
- Multi-level budgets.
- Per-tenant prices.

## Tests
`pnpm test`: 448 tests in 27 files (385 from Phases 1-3, unchanged in behaviour; 63 new or extended). New or extended files:

| File | Covers |
| --- | --- |
| `tests/unit/migrations.test.ts` (extended) | Migration 007 on PGlite: `admins` lowercase/email CHECK, `model_prices` uniqueness and non-negative CHECKs, RLS on both tables. The four aggregate functions against seeded logs: tenant isolation, range boundary, zero-filled UTC days, open-circuit counting (expired trips and repeat trips excluded), top-spender ordering and limit, unpriced models. None of the functions is executable by PUBLIC |
| `tests/unit/pricing.test.ts` (extended) | `stripModelVersion` (dated, compact-dated, `-NNN`, `-latest`); `findPricing` prefers exact matches, prices snapshots with the family price, and never falls back from `gpt-4o-mini` to `gpt-4o` or across providers; the dashboard's provider list equals the Worker registry's |
| `tests/unit/crypto.test.ts` (extended) | `generateProxyKey`: format, digest, prefix, uniqueness |
| `tests/integration/dashboard-worker.test.ts` | Worker: DB price used for a dated snapshot, DB price beats the static table, static fallback, price table cached (one DB read for three requests), price-read failure records the request as unpriced instead of losing it, no price read when there is nothing to price. `last_used_at`: one write per key per window, again after the window, never for an unauthenticated request, skipped (not per-request) when Redis is down, never throws |
| `apps/dashboard/tests/validation.test.ts` | Every form schema: NUMERIC(12,4)/(12,6) bounds and decimals, exponent/sign/hex inputs rejected, zero velocity limit rejected, https-only webhooks (no `http:`, `javascript:` or `user:pw@`), UUID ids (no PostgREST filter injection), provider allow-list, `x-user-id` rules shared with the Worker, empty budget -> NULL (tenant default), analytics range |
| `apps/dashboard/tests/auth-and-actions.test.ts` | `decideAdmin` (all four outcomes, case-insensitive, unconfirmed email never trusted even when allowlisted). `buildAdminAction`: admin checked before validation; field errors without running the handler; the audit line names the admin and never the inputs; only `UserFacingError` messages reach the UI; redirects pass through |
| `apps/dashboard/tests/cache-and-format.test.ts` | `deleteCacheKeys` sends one `DEL` with every key and never throws (unconfigured, network, HTTP 500, Redis error). USD formatting keeps tiny costs visible. Axis ticks stay distinct below $1. LIKE escaping. The range start is UTC midnight |
| `apps/dashboard/tests/actions-are-wrapped.test.ts` | Every exported Server Action outside `app/login/actions.ts` is `export const x = adminAction(...)` |

`pnpm check` now also type-checks and lints the dashboard. `pnpm dashboard:build` (`next build`) and `pnpm build:check` (Worker bundle) pass.

**End-to-end run (not part of `pnpm test`)**:
- The setup:
  - Postgres 18 with Supabase-style `anon`/`authenticated`/`service_role` roles and Supabase's default grants.
  - All seven migrations applied.
  - Real PostgREST 16.4 in front of it.
  - A stub for the Supabase Auth endpoints and the Upstash REST endpoint.
  - The dashboard in `next dev`, driven by Playwright/Chromium.
- 36 checks passed, including:
  - `anon` reads `[]` from `admins`, its inserts are refused by RLS, and it gets "permission denied" calling `dashboard_summary`.
  - A credential is stored as `v1:` ciphertext and its plaintext never appears in any page.
  - The new key's SHA-256 equals `api_keys.key_hash`, and the key is gone after the dialog closes.
  - Revoke, block, price and policy changes each send the right Redis `DEL`.
  - The total-spend tile equals `sum(estimated_cost_usd)`.
  - A user removed from `admins` is sent to `/login?error=not_allowlisted`.
  - The Worker's `SupabaseStore.findModelPrices` and `touchApiKey` were also run against that PostgREST.
- Two dashboard bugs were found by this run and fixed (D14, D15), along with an axis-label bug: every tick printed "$0".

**Not tested**: real Supabase Auth email delivery and its redirect allow-list; a real Vercel deployment; a real Upstash instance; the Worker and dashboard against the same live Redis at once.

## Known Limitations
- **The dashboard server holds the system's most powerful secrets**: the service-role key, the credential encryption key and the Redis token. One action that skipped the admin check would expose all of them. This is mitigated by the single `adminAction` wrapper, the test that enforces it, and `getAdminDb()` for reads.
- **All admins can manage all tenants.** There are no roles and no per-tenant admins (D1).
- **The audit trail is log lines** (`admin_action`, with the admin email and action name) in Vercel's logs, not a database table.
- **Spend shown is settled spend.** Requests still in the queue are missing, and the Users page shows lifetime `end_users.current_spend_usd`, which is what the Worker's budget check compares against (through the Redis counter).
- **Prices are global and typed in by hand.** A wrong price mis-charges every tenant. The price form shows an example cost so unit mistakes (per token vs. per million) are visible before saving.
- **Snapshot matching only strips version suffixes.** A provider that reports a model under a completely different name than the price row stays unpriced. The Operations page lists those models so they can be added.
- **The allowlist check adds a little time before a magic link is sent,** so response timing could in principle hint whether an address is an admin. The reply text is identical either way.
- **"Review operational failures" links to Cloudflare** for logs and dead-letter queues rather than showing them (D12).

## SRS Traceability
| SRS | Implementation | Tests |
| --- | --- | --- |
| FR-4.1 | `packages/crypto/src/proxy-key.ts`, `app/(admin)/t/[tenantId]/keys/{actions.ts,create-key-dialog.tsx}` | `crypto.test.ts`, E2E |
| FR-4.2 | migration 007 `dashboard_*`, `lib/queries.ts`, `app/(admin)/t/[tenantId]/page.tsx`, `components/charts/*` | `migrations.test.ts`, E2E |
| SRS 12 tenants/policy/webhook | `app/(admin)/tenants/actions.ts`, `components/tenant-form.tsx`, `t/[tenantId]/settings` | `validation.test.ts`, E2E |
| SRS 12 provider credentials | `t/[tenantId]/providers/actions.ts` (`encryptSecret`, AAD `tenant:provider`) | `validation.test.ts`, E2E |
| SRS 12 end-user budgets | `t/[tenantId]/users/*` | `validation.test.ts`, E2E |
| SRS 12 circuit-breaker events | overview page, `listCircuitEvents` | `migrations.test.ts` (open-circuit count), E2E |
| SRS 12 operational failures | `t/[tenantId]/operations` (D12), `dashboard_unpriced_models` | `migrations.test.ts`, E2E |
| NFR-5.2 least privilege | `lib/auth.ts`, `lib/action.ts`, migration 007 RLS + REVOKE | `auth-and-actions.test.ts`, `actions-are-wrapped.test.ts`, `migrations.test.ts`, E2E |
| SRS 18 versioned pricing | `model_prices`, cost frozen per usage event (`usage-extractor.ts`) | `dashboard-worker.test.ts`, `pricing.test.ts` |
| SRS 17 (Phase 4) | keys once + digest only; analytics hold metadata only (no new text columns) | `crypto.test.ts`, E2E |
