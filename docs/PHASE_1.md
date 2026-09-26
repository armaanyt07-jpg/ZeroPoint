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
                    2. pipeline.ts    x-provider -> ProviderRegistry -> adapter                   (400)
                    3. budget.ts      end-user record + Redis spend, in parallel
                    4. auth.ts        blocked/suspended                                           (403)
                    5. budget.ts      spend >= limit                                              (429)
                    6. credentials.ts encrypted provider key -> AES-GCM decrypt
                    7. proxy.ts       adapter.buildProviderRequest -> fetch -> sanitized response
                  Directory (directory.ts): Upstash Redis cache  --miss-->  Supabase Postgres
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

## Decisions (not fully specified by the SRS)
1. **Key -> tenant lookup**: SHA-256 hash cached in Redis (`cache:apikey:{hash}`, 60 s; unknown keys cached 30 s), Postgres fallback. Consequence: revoking a key or blocking a user can take up to 60 s to take effect. These cache keys are additions to SRS section 10.
2. **Provider credentials**: new table `tenant_provider_credentials` (migration 002); AES-256-GCM ciphertext also cached in Redis (ciphertext only, never plaintext). The 32-byte master key is the `CREDENTIAL_ENCRYPTION_KEY` Worker secret.
3. **Budget**: `end_users.budget_limit_usd` if not null, else `tenants.default_budget_usd`. Missing Redis spend counter = 0. Comparison is `>=`. Users without an `end_users` row are treated as active with the tenant default (Phase 1 does not create rows; Phase 2 settlement will). **Spend stays 0 until Phase 2's asynchronous settlement writes `spend:{tenant}:{user}`**, so in Phase 1 the 429 path is only reachable if the counter is seeded manually.
4. **Provider selection**: explicit `x-provider` header (case-insensitive). Missing -> 400 `MISSING_PROVIDER`; unknown -> 400 `UNSUPPORTED_PROVIDER`; tenant has no key for it -> 400 `PROVIDER_NOT_CONFIGURED`. Only `openai` is implemented.
5. **Adapter interface**: `buildProviderRequest(request, providerApiKey)` takes the provider key as an extra argument (the SRS signature had no way to pass it). `authenticate(request)` is interpreted as "is this a request this adapter can serve" (method, path, Bearer present); real proxy-key authentication is in `auth.ts`. `parseStreamChunk` is a documented Phase 2 stub returning `null`. `calculateCost` implements the SRS section 9 formula against an injected pricing table; **Phase 1 ships no price table** and throws if a model has no pricing.
6. **Blocked users**: 403 `USER_BLOCKED` for `blocked`/`suspended`.
7. **Malformed `x-user-id`** (over 128 chars or control characters): 400 `INVALID_USER_ID`. Missing/blank: 401 per FR-1.1.
8. **Proxy key format**: must start with `pk_live_` (SRS 4/FR-4.1); anything else is rejected with 401 before hashing.
9. **Provider error handling** (SRS section 8 "sanitized"): provider 401/403 -> 502 `PROVIDER_AUTH_ERROR` (the tenant's key is wrong; body may echo key fragments); 5xx and network failures -> 502; other 4xx (bad request, rate limit) pass through with `Retry-After`, with the credential scrubbed if echoed.
10. **Header forwarding**: allow-list only (`content-type`, `accept`, `openai-organization`, `openai-project`, `openai-beta`) + the injected `Authorization`.
11. **RLS** (migration 003): row-level security enabled with no policies so Supabase's public anon key can read nothing; only the service-role key (Worker secret) can.
12. **Tooling**: single root package with TS path aliases (`@zeropoint/*`) instead of pnpm workspaces; Redis/Supabase accessed via `fetch` (Upstash REST, PostgREST) with no SDKs; Vitest on Node with in-memory fakes. Pinned to TypeScript 6 because typescript-eslint does not support TS 7 yet. `packages/schemas` (in the SRS layout) is not created because Phase 1 has no shared runtime schemas.
13. **Dev helper** (`scripts/dev-helper.ts`): hashing/encrypting utilities so a database can be seeded by hand until Phase 4 provisioning exists.

## Implementation Status
**Completed**: FR-1.1, FR-1.2, FR-1.3, FR-1.4 (OpenAI), fail-open Redis, credential encryption, DB migrations, sanitized errors, health route, Phase 1 telemetry (`requests_total`, `requests_allowed`, `requests_rejected`, `budget_rejections`, `redis_failures`, `provider_errors`).

**In progress**: none.

**Not implemented (by design)**:
- Anthropic / Gemini adapters (only the extension point exists)
- Phase 2: `tee()` streaming, SSE parsing, token/cost accounting, queues, settlement, spend writes
- Phase 3: velocity breaker, loop detection, circuit state, webhooks
- Phase 4: dashboard, key provisioning UI
- Unused telemetry names (`queue_failures`, `circuit_breaker_events`, `streaming_requests`, `token_usage`, `estimated_spend`)

## Tests
Run with `pnpm test` (Vitest, 91 tests, 8 files) - all passing at the time of writing.

| File | Covers |
| --- | --- |
| `tests/unit/crypto.test.ts` | SHA-256 vectors, AES-GCM round trip, fresh IV, wrong key, wrong AAD, tampering, bad input |
| `tests/unit/pricing.test.ts` | Cost formula, invalid input, pricing lookup |
| `tests/unit/openai-adapter.test.ts` | `authenticate`, header allow-list, proxy key removal, provider key injection, body pass-through, Phase 2 stub, registry |
| `tests/unit/auth.test.ts` | Header parsing, every 401 path, invalid user id, blocked/suspended -> 403 |
| `tests/unit/directory.test.ts` | Cache miss/hit, negative cache, Redis outage fallback, corrupt cache, DB failure, tenant-scoped keys |
| `tests/unit/budget.test.ts` | `>=` comparison, per-user vs default limit, missing counter, fail-open, tenant isolation |
| `tests/unit/clients.test.ts` | Upstash and Supabase request shapes, error mapping, filter-injection safety |
| `tests/integration/proxy.test.ts` | Full pipeline: happy path, streaming pass-through, 401/403/429/400/502/503, provider selection, sanitized provider errors, router, telemetry |

Also verified against the real Workers runtime (workerd, `wrangler dev`) with a local mock of Upstash/Supabase: 401 (missing key, bad key, missing user), 403 (blocked), 429 (over budget), 400 (missing/unsupported provider), 405, `/health`.
**Not** tested: a live call to OpenAI, real Upstash/Supabase, and latency targets (NFR-5.1) - no credentials or infrastructure were available. Load tests (SRS 16.3) are not part of Phase 1.

## Known Limitations
- Spend is never written in Phase 1 (settlement = Phase 2), so budget enforcement needs a manually seeded `spend:*` key to trigger.
- Revocation/blocking is eventually consistent (cache TTL 60 s; negative cache 30 s).
- Budget math uses JS floating point; adequate for Phase 1 comparisons, revisit for settlement.
- Only OpenAI `/v1/chat/completions`. No request body size limit or inbound rate limiting.
- `end_users` rows are not auto-created; `last_used_at` is not updated.
- Latency (<10 ms) is unmeasured; on a cache hit the request makes ~3 sequential Redis round trips (api key; user + spend in parallel; credential).
- Metrics are structured console logs, not a metrics backend.

## SRS Traceability
| SRS | Implementation | Tests |
| --- | --- | --- |
| FR-1.1 | `auth.ts` `authenticate`, `extractBearerToken`, `extractUserId`; `packages/crypto/src/hash.ts` | `auth.test.ts`, `proxy.test.ts` "authentication" |
| FR-1.2 | `budget.ts` (`resolveBudgetLimit`, `isOverBudget`, `getCurrentSpend`, `assertWithinBudget`); `pipeline.ts` step 5 | `budget.test.ts`, `proxy.test.ts` "budget guardrail" |
| FR-1.3 | `packages/providers/src/openai.ts` `buildProviderRequest`; `credentials.ts` | `openai-adapter.test.ts`, `proxy.test.ts` "happy path" |
| FR-1.4 | `packages/providers/src/{adapter,registry,openai}.ts`; `pipeline.ts` step 2 | `openai-adapter.test.ts`, `proxy.test.ts` "provider selection" |
| NFR-5.2 | `packages/crypto`, `credentials.ts`, `003_enable_row_level_security.sql`, no credential logging | `crypto.test.ts`, `proxy.test.ts` |
| NFR-5.3 | `budget.ts` `getCurrentSpend`, `directory.ts` | `budget.test.ts`, `directory.test.ts` |
| NFR-5.5 | `telemetry.ts` (Phase 1 subset) | `proxy.test.ts` "telemetry" |
| NFR-5.6 | `packages/providers/src/adapter.ts` | `openai-adapter.test.ts` |
| SRS 4.3 | `database/migrations/001_init.sql` (verbatim), 002 (addition) | not executed against a live Postgres |
| SRS 6.2/6.3 | `errors.ts` | `proxy.test.ts` |
| SRS 8 | `proxy.ts`, `pipeline.ts` `toSafeResponse` | `proxy.test.ts` "provider errors" |
| SRS 10 | `budget.ts` `spendKey` | `budget.test.ts` |
| SRS 9 | `packages/pricing` | `pricing.test.ts` |

## Note on the SRS
Section 13's traceability table lists "FR-3.7 Webhooks", which does not exist in section 3. It is a Phase 3 item and has no effect on Phase 1.
