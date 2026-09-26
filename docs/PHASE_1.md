# Phase 1

## Objective
Core Edge Proxy & Pre-Flight Budget Guardrails (SRS section 3, Phase 1): a Cloudflare Worker that authenticates
callers, checks the user's budget **before** any LLM provider is contacted, swaps the client's proxy key for the
tenant's real provider key, and forwards the request.

## SRS Requirements
| ID | Requirement (summary) |
| --- | --- |
| FR-1.1 | `Authorization: Bearer <PROXY_KEY>` + `x-user-id`; missing/invalid -> 401 |
| FR-1.2 | `current_spend >= budget_limit` -> 429 before contacting the provider |
| FR-1.3 | Replace the proxy credential with the provider credential; never forward the proxy key |
| FR-1.4 | Provider routing through modular adapters (OpenAI, Anthropic, Gemini, future) |
| NFR-5.2 | SHA-256 proxy keys, AES-256-GCM provider credentials, no credentials in logs/clients, tenant-scoped Redis keys |
| NFR-5.3 | Redis failure = fail-open with telemetry |
| NFR-5.6 | Provider logic behind `LLMProviderAdapter` |
| SRS 6.2 / 6.3 / 8 | Error response shapes; sanitized client/provider errors |
| SRS 17 (Phase 1) | Valid keys authenticate; invalid/missing -> 401; over-budget -> 429 pre-provider; provider creds replace proxy creds |

## Architecture
```
Client --HTTPS--> Worker (router -> pipeline)
                    1. auth.ts        Bearer -> SHA-256 -> Directory.getApiKey -> x-user-id      (401)
                    2. pipeline.ts    x-provider -> ProviderRegistry -> adapter (openai|anthropic|gemini) (400)
                    3. end-user record + Redis spend + encrypted provider key, all in parallel
                    4. auth.ts        blocked/suspended                                           (403)
                    5. budget.ts      spend >= limit                                              (429)
                    6. credentials.ts AES-GCM decrypt of the provider key
                    7. proxy.ts       adapter.buildProviderRequest -> fetch -> allow-listed headers / normalized errors
                  Directory (directory.ts): Upstash Redis cache  --miss-->  Supabase Postgres
                                            (cache writes run in ctx.waitUntil, off the request path)
Routing: router.ts asks the provider registry whether ANY adapter serves the path
(/v1/chat/completions, /v1/messages, /v1beta/models/<model>:generateContent|streamGenerateContent);
unknown path -> 404, non-POST -> 405. The pipeline then requires x-provider to match the path.
```
Key files: `apps/worker/src/{index,router,pipeline,auth,budget,credentials,proxy,directory,redis,store,deps,env,errors,telemetry}.ts`,
`packages/{types,crypto,pricing,providers}`, `database/migrations/*.sql`, `apps/worker/wrangler.toml`.

Request flow order follows SRS section 7 minus the circuit breaker (Phase 3).

### Concepts introduced
- **Middleware / pipeline**: rather than a framework, `pipeline.ts` runs the checks in a fixed order and any check can stop the request by throwing a `ZeroPointError`, which is converted to the SRS JSON error. Order matters: cheap and security-critical checks run first.
- **Authentication vs authorization**: `authenticate()` answers "who are you?" (proxy key -> tenant); `assertUserAllowed()` and the budget check answer "are you allowed right now?".
- **Read-through cache (Redis)**: `Directory` looks in Upstash Redis first and falls back to Postgres on a miss, then stores the result for 60 s. Postgres stays the source of truth; Redis keeps the hot path fast (NFR-5.1).
- **Fail-open**: if Redis errors or times out (1 s), the spend read returns 0 and emits `redis_failures` so protection degrades instead of taking customers offline (NFR-5.3). Database (auth) failures do NOT fail open: they return 503 because we cannot verify who is calling.
- **Provider adapter**: `LLMProviderAdapter` hides provider differences (URL, headers, auth scheme). Adding Anthropic/Gemini = add an adapter and register it in `packages/providers/src/registry.ts`; the pipeline is untouched.
- **AES-256-GCM with AAD**: provider keys are encrypted with the Web Crypto API. Each ciphertext is bound to `"<tenantId>:<provider>"`, so copying a ciphertext into another tenant's row fails to decrypt.
- **Streaming pass-through**: request and response bodies are passed as streams and never read into memory (SRS 2.3).
- **`ExecutionContext.waitUntil`**: a Worker normally stops when the response is sent. `ctx.waitUntil(promise)` lets a promise (here: writing to the Redis cache) finish after the response, so it adds no latency. It reaches `Directory` through `createDependencies(env, ctx, telemetry)`.
- **Response header allow-list**: only `content-type` and `cache-control` are copied from the provider's response, so headers such as `openai-organization` or `x-request-id` never reach the client.

## Decisions (not fully specified by the SRS)
1. **Key -> tenant lookup**: SHA-256 hash cached in Redis (`cache:apikey:{hash}`, 60 s; unknown keys cached 30 s), Postgres fallback. Consequence: revoking a key or blocking a user can take up to 60 s to take effect. These cache keys are additions to SRS section 10.
2. **Provider credentials**: new table `tenant_provider_credentials` (migration 002); AES-256-GCM ciphertext also cached in Redis (ciphertext only, never plaintext). The 32-byte master key is the `CREDENTIAL_ENCRYPTION_KEY` Worker secret.
3. **Budget**: `end_users.budget_limit_usd` if not null, else `tenants.default_budget_usd`. Missing Redis spend counter = 0. Comparison is `>=`. Users without an `end_users` row are treated as active with the tenant default (Phase 1 does not create rows; Phase 2 settlement will). **Spend stays 0 until Phase 2's asynchronous settlement writes `spend:{tenant}:{user}`**, so in Phase 1 the 429 path is only reachable if the counter is seeded manually.
4. **Provider selection**: explicit `x-provider` header (case-insensitive) that must match the requested path. Missing -> 400 `MISSING_PROVIDER`; unknown provider or provider/path mismatch -> 400 `UNSUPPORTED_PROVIDER`; tenant has no key for it -> 400 `PROVIDER_NOT_CONFIGURED`. `openai`, `anthropic` and `gemini` are implemented (added after review; see Review Remediation). Clients authenticate to ZeroPoint with `Authorization: Bearer <proxy key>` for every provider (FR-1.1), even though the upstream providers use `x-api-key` / `x-goog-api-key`.
5. **Adapter interface**: `buildProviderRequest(request, providerApiKey)` takes the provider key as an extra argument (the SRS signature had no way to pass it), and `matchesPath(pathname)` was added so the router can recognise each provider's URL shape. `authenticate(request)` is interpreted as "is this a request this adapter can serve" (method, path, Bearer present); real proxy-key authentication is in `auth.ts`. `parseStreamChunk` is a documented Phase 2 stub returning `null`. `calculateCost` implements the SRS section 9 formula against an injected pricing table; **Phase 1 ships no price table** and throws if a model has no pricing.
6. **Blocked users**: 403 `USER_BLOCKED` for `blocked`/`suspended`.
7. **Malformed `x-user-id`** (over 128 chars or control characters): 400 `INVALID_USER_ID`. Missing/blank: 401 per FR-1.1.
8. **Proxy key format**: must start with `pk_live_` (SRS 4/FR-4.1); anything else is rejected with 401 before hashing.
9. **Provider error handling** (SRS sections 6 and 8): every provider error becomes `{ "error": { "code", "message" } }`. Provider 401/403 -> 502 `PROVIDER_AUTH_ERROR` (the tenant's key is wrong; the body may echo key fragments, so it is dropped); 5xx and network failures -> 502 `PROVIDER_ERROR` / `PROVIDER_UNREACHABLE`; other 4xx keep their status with code `PROVIDER_RATE_LIMITED` (429, plus a numeric `Retry-After`) or `PROVIDER_REQUEST_REJECTED`. Only the provider's `error.message` string is kept: redacted (exact key plus `sk-...` / `AIza...` shapes, which also catches masked echoes) and cut to 300 characters.
10. **Header forwarding**: request allow-list per adapter (OpenAI: `content-type`, `accept`, `openai-beta`, and NOT `openai-organization` / `openai-project`, so clients cannot choose which org or project is billed; Anthropic: `content-type`, `accept`, `anthropic-version` (default `2023-06-01`), `anthropic-beta`; Gemini: `content-type`, `accept`) plus the injected provider credential. Gemini forwards only `?alt=sse|json`; its model path must match a strict pattern, so clients can pick a model but not a different upstream path. Response allow-list: `content-type`, `cache-control`.
11. **RLS** (migration 003): row-level security enabled with no policies so Supabase's public anon key can read nothing; only the service-role key (Worker secret) can.
12. **Tooling**: single root package with TS path aliases (`@zeropoint/*`) instead of pnpm workspaces; Redis/Supabase accessed via `fetch` (Upstash REST, PostgREST) with no SDKs; Vitest on Node with in-memory fakes. Pinned to TypeScript 6 because typescript-eslint does not support TS 7 yet. `packages/schemas` (in the SRS layout) is not created because Phase 1 has no shared runtime schemas.
13. **`/health`** (not in the SRS): GET/HEAD only; 200 `{status:"ok"}` when all required secrets are present, 503 `{status:"unavailable"}` otherwise (never says which). It makes no Redis/Postgres calls and is not counted in the request metrics.
14. **`request_id`**: a UUID generated per request, returned as `x-request-id` on every proxy response and stamped on every log line. Client-supplied `x-request-id` values are ignored and nothing is sent upstream. Phase 1 does not persist it; storing it in `request_logs` and using it for settlement idempotency (FR-2.4) is Phase 2.
15. **Migration 004** (not in SRS): `CHECK (>= 0)` on `tenants.default_budget_usd` and `end_users.budget_limit_usd`, added as a new migration so 001 stays identical to the SRS.
16. **Dev helper** (`scripts/dev-helper.ts`): hashing/encrypting utilities so a database can be seeded by hand until Phase 4 provisioning exists.

## Implementation Status
**Completed**: FR-1.1, FR-1.2, FR-1.3, FR-1.4 (OpenAI, Anthropic, Gemini), fail-open Redis, credential encryption, DB migrations, sanitized errors, health route, Phase 1 telemetry (`requests_total`, `requests_allowed`, `requests_rejected`, `budget_rejections`, `redis_failures`, `provider_errors`).

**In progress**: none.

**Not implemented (by design)**:
- Phase 2: `tee()` streaming, SSE parsing, token/cost accounting, queues, settlement, spend writes
- Phase 3: velocity breaker, loop detection, circuit state, webhooks
- Phase 4: dashboard, key provisioning UI
- Unused telemetry names (`queue_failures`, `circuit_breaker_events`, `streaming_requests`, `token_usage`, `estimated_spend`)

## Tests
Run with `pnpm test` (Vitest, 187 tests, 13 files) - all passing at the time of writing.

| File | Covers |
| --- | --- |
| `tests/unit/crypto.test.ts` | SHA-256 vectors, AES-GCM round trip, fresh IV, wrong key, wrong AAD, tampering, bad input |
| `tests/unit/pricing.test.ts` | Cost formula, invalid input, pricing lookup |
| `tests/unit/openai-adapter.test.ts` | `authenticate`, header allow-list, proxy key removal, provider key injection, body pass-through, Phase 2 stub, registry |
| `tests/unit/auth.test.ts` | Header parsing, every 401 path, invalid user id, blocked/suspended -> 403 |
| `tests/unit/directory.test.ts` | Cache miss/hit, negative cache, Redis outage fallback, corrupt cache, DB failure, tenant-scoped keys |
| `tests/unit/budget.test.ts` | `>=` comparison, per-user vs default limit, missing counter, fail-open, tenant isolation |
| `tests/unit/clients.test.ts` | Upstash and Supabase request shapes, error mapping, filter-injection safety, raw `eq.` semantics for awkward user ids |
| `tests/unit/redis-numeric.test.ts` | Numeric Redis results are kept (not read as $0); unexpected types fail open with telemetry |
| `tests/unit/anthropic-gemini-adapters.test.ts` | Path matching, `x-api-key` / `x-goog-api-key`, no Authorization upstream, query-string allow-list, registry routing |
| `tests/unit/migrations.test.ts` | Runs migrations 001-004 on a real in-process PostgreSQL (PGlite): tables, SRS defaults, RLS on, uniqueness, non-negative budget checks |
| `tests/integration/minor-fixes.test.ts` | `/health` verbs and readiness, `x-request-id` on every response and log line (also through `index.ts`), client `x-request-id` ignored |
| `tests/integration/review-fixes.test.ts` | Regression tests for every review fix: accounting invariant, response headers, new providers end to end, parallel lookups, non-blocking cache writes, `index.ts` + `ctx.waitUntil`, 503/500/404/405 counted, normalized provider errors, error precedence |
| `tests/integration/proxy.test.ts` | Full pipeline: happy path, streaming pass-through, 401/403/429/400/502/503, provider selection, sanitized provider errors, router, telemetry |

Also verified against the real Workers runtime (workerd, `wrangler dev`) with a local mock of Upstash/Supabase: 401, 403 (blocked), 429 (over budget) on the OpenAI, Anthropic and Gemini paths, 400 (provider/path mismatch), 404, 405, `/health`. Each review fix was also mutation-checked: re-introducing the bug makes the new tests fail.
**Not** tested: a live call to any provider, real Upstash/Supabase (the SQL is only run on PGlite), and latency targets (NFR-5.1) - no credentials or infrastructure were available. Load tests (SRS 16.3) are not part of Phase 1.

## Known Limitations
- Spend is never written in Phase 1 (settlement = Phase 2), so budget enforcement needs a manually seeded `spend:*` key to trigger.
- Revocation/blocking is eventually consistent (cache TTL 60 s; negative cache 30 s).
- Budget math uses JS floating point; adequate for Phase 1 comparisons, revisit for settlement.
- Chat-style endpoints only: OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`, Gemini `:generateContent` / `:streamGenerateContent`. No request body size limit or inbound rate limiting.
- `end_users` rows are not auto-created; `last_used_at` is not updated.
- Latency (<10 ms) is unmeasured. On a cache hit the request makes two sequential Redis stages (api key, then user + spend + credential in parallel); cache-miss writes are off the request path. A cold cache still costs a Postgres round trip.
- Metrics are structured console logs, not a metrics backend.

## SRS Traceability
| SRS | Implementation | Tests |
| --- | --- | --- |
| FR-1.1 | `auth.ts` `authenticate`, `extractBearerToken`, `extractUserId`; `packages/crypto/src/hash.ts` | `auth.test.ts`, `proxy.test.ts` "authentication" |
| FR-1.2 | `budget.ts` (`resolveBudgetLimit`, `isOverBudget`, `getCurrentSpend`, `assertWithinBudget`); `pipeline.ts` step 5 | `budget.test.ts`, `proxy.test.ts` "budget guardrail" |
| FR-1.3 | `packages/providers/src/openai.ts` `buildProviderRequest`; `credentials.ts` | `openai-adapter.test.ts`, `proxy.test.ts` "happy path" |
| FR-1.4 | `packages/providers/src/{adapter,registry,openai,anthropic,gemini}.ts`; `router.ts`; `pipeline.ts` step 2 | `openai-adapter.test.ts`, `anthropic-gemini-adapters.test.ts`, `proxy.test.ts` "provider selection", `review-fixes.test.ts` "Major 1" |
| NFR-5.2 | `packages/crypto`, `credentials.ts`, `003_enable_row_level_security.sql`, no credential logging | `crypto.test.ts`, `proxy.test.ts` |
| NFR-5.3 | `budget.ts` `getCurrentSpend`, `directory.ts` | `budget.test.ts`, `directory.test.ts` |
| NFR-5.1 | Parallel lookups in `pipeline.ts`; `defer` in `directory.ts`; `ctx` in `index.ts` (latency itself is unmeasured) | `review-fixes.test.ts` "Major 2/3" |
| NFR-5.5 | `telemetry.ts`, `errorToResponse` in `pipeline.ts`, `router.ts` | `proxy.test.ts` "telemetry", `review-fixes.test.ts` "Critical 1", "Major 4" |
| NFR-5.6 | `packages/providers/src/adapter.ts` | `openai-adapter.test.ts` |
| SRS 4.3 | `database/migrations/001_init.sql` (verbatim), 002-004 (additions) | `migrations.test.ts` (PGlite; not run on Supabase itself) |
| SRS 6.2/6.3 | `errors.ts` | `proxy.test.ts` |
| SRS 6 / 8 (error schema) | `proxy.ts` `normalizeProviderError`, `redactSecrets` | `review-fixes.test.ts` "Major 5" |
| SRS 8 | `proxy.ts`, `pipeline.ts` `toSafeResponse` | `proxy.test.ts` "provider errors" |
| SRS 10 | `budget.ts` `spendKey` | `budget.test.ts` |
| SRS 9 | `packages/pricing` | `pricing.test.ts` |

## Review Remediation
Source: `docs/PHASE_1_REVIEW.md`. Critical and Major issues were handled first; Minor issues follow in the next section. The "Missing Requirements" table was not part of either pass.

| Issue | Outcome |
| --- | --- |
| Critical 1: `requests_allowed` counted before the upstream call | **Fixed** as recommended. `requests_allowed` is recorded only after `forwardToProvider` returns. |
| Critical 2: provider headers leak to clients | **Fixed**, using an allow-list (`content-type`, `cache-control`) rather than the recommended deny-list, so unknown headers are dropped by default. |
| Critical 3: numeric Redis results read as `null` | **Fixed** (numbers are stringified). Differs slightly from the suggestion: other unexpected types (objects, arrays) raise a `RedisError` instead of becoming `"[object Object]"`. Note: Upstash normally returns strings for `GET`, so the reported bypass is unlikely in practice, but the fix is correct and cheap. |
| Critical 4: quote PostgREST filter values | **Not applied, on purpose.** PostgREST parses an `eq.` value as raw text (`pSingleVal = many anyChar` in `QueryParams.hs`); quotes are only interpreted inside `in.(...)` and `or=(...)`. `eq."user"` would compare against the literal string `"user"`, so no user would match and per-user budgets and blocking would silently stop working. The reviewer's `""` escape is also not PostgREST's syntax (it uses `\"`). `eq.null` is a plain string comparison (SQL NULL needs `is.null`), and commas/dots are fine in `eq.` values. Instead, regression tests pin the current behaviour (`clients.test.ts`); applying the recommended change breaks 12 tests. Evidence is from the PostgREST source; it was not run against a live PostgREST. |
| Major 1: Anthropic and Gemini adapters | **Fixed.** New adapters, registry entries and path-based routing. `x-provider` must match the path. This reverses the earlier "OpenAI first" scoping. |
| Major 2: latency (parallelize, non-blocking writes) | **Fixed.** Credential ciphertext is fetched in parallel with user and spend; cache writes are deferred. Deviation from the suggested snippet: the credential lookup is *started* in parallel but *awaited after* the 403/429 checks, so a credential-store failure cannot turn a blocked or over-budget user's 403/429 into a 503 (caught by the real-runtime smoke test). The <10 ms target is still unmeasured. |
| Major 3: missing `ExecutionContext` | **Fixed.** `index.ts` takes `ctx`; `Directory` writes the cache through `ctx.waitUntil`. `last_used_at` updates were not added. |
| Major 4: rejections not counted | **Fixed.** 503, 500 and configuration errors go through `errorToResponse`; 404/405 are counted in the router as both `requests_total` and `requests_rejected` so `total = allowed + rejected` holds. `/health` is not counted. |
| Major 5: inconsistent provider 4xx schema | **Fixed.** Provider errors use `{ error: { code, message } }` with pattern-based secret redaction. New codes: `PROVIDER_RATE_LIMITED`, `PROVIDER_REQUEST_REJECTED`. |

Existing tests changed because behaviour was intentionally reversed: `anthropic`/`gemini` are no longer "unsupported providers", the registry now lists three providers, the provider-4xx pass-through test now expects the normalized schema, and the `redis_failures` cache-write count is read after background work is flushed.

### Minor findings
| # | Finding | Status |
| --- | --- | --- |
| 1 | `/health` accepts any verb and ignores configuration | **Fixed.** GET/HEAD only, 503 when secrets are missing. Probing Redis/Postgres from `/health` is deferred: the SRS defines no health endpoint, and a deep check would add network calls and an amplification path. |
| 2 | No `request_id` | **Fixed for the edge** (generated, returned as `x-request-id`, tagged on logs). Persisting it and using it for settlement is Phase 2 (FR-2.3/2.4). It is deliberately not sent to providers. |
| 3 | Client-supplied `openai-organization` / `openai-project` forwarded | **Fixed** by no longer forwarding them. Per-tenant org/project settings (the reviewer's fuller fix) are deferred: they need a schema change and a provisioning UI (Phase 4). |
| 4 | No non-negative budget CHECKs | **Fixed** with migration 004 (new file, not an edit of 001), verified on PGlite. |

## Note on the SRS
Section 13's traceability table lists "FR-3.7 Webhooks", which does not exist in section 3. It is a Phase 3 item and has no effect on Phase 1.
