# Phase 3 Plan: Runaway Agent Loop Circuit Breaker ("WOW" Feature)

Status: **approved** (decisions D1-D7 resolved below). Source: `docs/ZeroPoint_SRS_v1.0.pdf`.

## Phase 3 Requirements

| ID | What the SRS says |
| --- | --- |
| FR-3.1 | Maintain a 60-second sliding spending window in Redis sorted sets: `velocity:{tenant_id}:{user_id}`. `ZADD velocity:<key> <timestamp> <cost>`; expired entries removed with `ZREMRANGEBYSCORE` before calculating current velocity. |
| FR-3.2 | Default threshold $2.00 per 60 seconds. If spend rate exceeds it, the circuit opens. |
| FR-3.3 | SHA-256 hash of a normalized request representation; retain the last five hashes per user (`hashes:{tenant_id}:{user_id}`). Three consecutive matching hashes trigger the loop-detection breaker. |
| FR-3.4 | On trigger: set circuit state OPEN, block requests for 15 minutes, record the event, dispatch a developer webhook. |
| FR-3.5 | States CLOSED and OPEN with a 15-minute expiration (`circuit:{tenant_id}:{user_id}`). HALF_OPEN deferred. |
| FR-3.7 | Webhooks (traceability: Phase 3, Queue/Worker component). |
| SRS 6.4 | 429 `CIRCUIT_OPEN`, `Retry-After: 900`. |
| SRS 7 | Lifecycle order: Circuit OPEN? (429) → Budget Check (429) → Hash Request → 3 consecutive? → Open Circuit (429) : Forward. |
| SRS 8 | Circuit-breaker state lives in Redis; horizontally scalable (NFR-5.4). |
| NFR-5.5 | `circuit_breaker_events` metric (already declared, unused since Phase 1). |
| SRS 4.3 | `tenants.velocity_limit_usd`, `velocity_window_seconds`, `circuit_breaker_duration_seconds`, `webhook_url` already exist (migration 001, unused since Phase 1). `request_logs.circuit_breaker_triggered/reason` already exist, unused. |

## Current State (Phase 1/2 hand-off)

- `pipeline.ts` docstring explicitly reserves a slot: "authenticate → pick provider → ... (minus the circuit breaker which arrives in Phase 3)".
- Tenant policy columns exist in the schema but nothing reads them: `ApiKeyRecord`/`AuthContext` carry only `defaultBudgetUsd`.
- `RedisClient` has `get`/`set`/`eval`; sorted sets and lists are reachable only through `eval` (no new client methods needed — same pattern as `SETTLE_SCRIPT`).
- One Cloudflare Queue (`USAGE_QUEUE`) exists; the consumer (`index.ts` `queue()`) assumes every message is a usage event.
- No table exists yet for circuit-breaker audit events (needed for the Phase 4 dashboard's "CIRCUIT BREAKER EVENTS" panel and SRS section 12's "View circuit-breaker events").

## Proposed Changes

New: `apps/worker/src/circuit-breaker.ts` (Redis key builders, the two Lua scripts, and the functions that call them), `apps/worker/src/webhook-queue.ts` (producer, mirrors `usage-queue.ts`), `apps/worker/src/webhook-dispatch.ts` (consumer: POST to `webhook_url`), migration `006_circuit_breaker.sql`.

Changed: `store.ts` (tenant policy read, circuit-breaker-event write), `auth.ts` (`AuthContext` carries tenant policy), `pipeline.ts` (circuit check + hash check wired into the request lifecycle), `settlement.ts` (velocity check runs after a successful settle), `errors.ts` (`CIRCUIT_OPEN`), `deps.ts`/`env.ts`/`wrangler.toml` (`WEBHOOK_QUEUE` binding), `index.ts` (`queue()` dispatches on `batch.queue`).

## Where Each Check Runs

Velocity (FR-3.1/3.2) needs the request's **cost**, which is only known after the provider has answered and usage has been extracted — so it is evaluated in `settlement.ts`, immediately after a usage event is newly settled (not on a duplicate redelivery). A breach opens the circuit for the *next* request; the request that tipped the scale already completed (nothing else is possible — its cost is what triggered the breach).

Pattern hashing (FR-3.3) is evaluated in `pipeline.ts`, after the budget check and before the provider is contacted, matching the SRS lifecycle diagram exactly. The request that produces the third consecutive matching hash is itself blocked (never forwarded) — that's what "loop detection" means.

## Decisions (not fully specified by the SRS)

1. **D1: request hashing requires reading the body.** FR-3.3 needs a hash of the request, so the body must be read before it can be forwarded. `pipeline.ts` clones the incoming `Request` up front (`Request.clone()`, same idea as `tee()`) so the original, unread body still reaches the adapter untouched; the clone is read up to `MAX_INSPECTED_REQUEST_BYTES` (1 MiB, the same cap Phase 2 already uses for the OpenAI opt-in) and hashed as `sha256(providerId + "\n" + pathname + "\n" + bodyBytes)`. A body over the cap is exempt from hash tracking (streamed through, never buffered) — a known limitation: very large agent payloads only get velocity-based protection, not loop detection. This is a genuine latency/memory cost added to every request (`NFR-5.1` accepts a similar cost from `D2` in Phase 2); there was no way to satisfy FR-3.3 without it.
2. **D2: circuit value encoding.** `circuit:{tenant}:{user}` stores `"<reason>:<expiresAtEpochMs>"` (no JSON/`cjson` — the SRS gives Redis raw Lua `EVAL`, and `cjson` is a Redis extension the test Lua VM (`fengari`, used so the *exact* script text under test executes for real) does not provide). `Retry-After` and the audit record's `expires_at` are computed from the embedded timestamp, not from Redis `TTL`, saving a round trip and staying correct even if the key is read a moment before Redis's own expiry sweep runs.
3. **D3: velocity math.** Sorted-set members are `"<requestId>:<cost>"` (score = event time in ms) so they stay unique per request (`ZADD` on a duplicate member would just move its score, undercounting) while still letting the script recover each entry's cost with `string.match`. After pruning entries older than `velocity_window_seconds`, the script sums the remaining costs and opens the circuit only if the total exceeds `velocity_limit_usd` — matching "exceeds", not "reaches". An already-open circuit is left alone (`EXISTS` guard) so a burst of settlements can't re-open it (and re-fire the webhook) many times in the same window.
4. **D4: `circuit_breaker_events` is a new table** (migration 006, additive — like migrations 002/005 — so 001 stays byte-identical to the SRS). Columns: `tenant_id`, `external_user_id` (denormalized, not FK'd to `end_users` — a loop can be detected for a user who has no settled requests yet, since settlement is asynchronous), `reason` (`velocity`/`loop`), `opened_at`, `expires_at`. This is what "record the event" (FR-3.4) means and what a future dashboard reads for SRS section 12's "View circuit-breaker events". The write is best-effort (logged, never retried, never fails the request or the settlement message): it is an audit trail, not financial accounting, so it doesn't get `settle_usage`'s durability guarantees. No `webhook_dispatched` column: a trip and its queued notification share no id to join on, and whether the webhook itself was delivered is already observable via telemetry/logs — adding one would be state nothing reads.
5. **D5: `request_logs.circuit_breaker_triggered`/`circuit_breaker_reason` stay at their defaults.** A request blocked by the circuit breaker never reaches a provider, so there is no usage event and no `request_logs` row to set them on (same reasoning as Phase 2's D6: only 2xx responses are settled). These columns appear to anticipate logging a *forwarded* request that happened to also trip a breaker mid-flight, which cannot occur in this architecture (the breaker check happens strictly before forwarding). Left unused, as Phase 2 already flagged.
6. **D6: webhooks are queued, not sent inline.** FR-3.7's traceability lists "Queue/Worker", and dispatching an HTTP POST inline (from the request path for a loop trip, or from the settlement consumer for a velocity trip) would tie a governance action to an arbitrary third-party endpoint's latency/availability. A new `WEBHOOK_QUEUE` (own DLQ) carries `{tenantId, externalUserId, reason, webhookUrl, openedAt, expiresAt}`; a consumer POSTs it with a bounded timeout and retries with backoff, like usage settlement. A tenant with no `webhook_url` configured gets no dispatch attempt (not an error). No payload signing: the schema has no webhook secret column, so nothing was invented (mirrors Phase 2's D3 "no prices invented").
7. **D7: `HALF_OPEN` and fail-closed are out of scope** (SRS: "a future HALF_OPEN state may support..."; NFR-5.3: "a future tenant-level Fail-Closed policy may be supported"). Both are explicitly future work in the SRS text itself. A Redis failure during a circuit-state read fails open (same NFR-5.3 policy as the budget check): a governance outage must not take a customer's app offline.

## File/Component Mapping

| Requirement | Files |
| --- | --- |
| FR-3.1/3.2 velocity | `circuit-breaker.ts` (`VELOCITY_SCRIPT`), `settlement.ts` |
| FR-3.3 hashing | `circuit-breaker.ts` (`HASH_SCRIPT`, `hashRequest`), `pipeline.ts` |
| FR-3.4/3.5 state machine | `circuit-breaker.ts` (`circuitKey`, `readCircuitState`), `pipeline.ts`, `errors.ts` |
| FR-3.7 webhooks | `webhook-queue.ts`, `webhook-dispatch.ts`, `index.ts`, `wrangler.toml` |
| Tenant policy | `store.ts`, `auth.ts`, `deps.ts` |
| Audit trail | `store.ts` (`recordCircuitBreakerEvent`), migration 006 |
| NFR-5.5 | `telemetry.ts` tags on the existing `circuit_breaker_events` metric |

## Redis Keys (SRS section 10)

| Key | Type | Written by | Read by |
| --- | --- | --- | --- |
| `circuit:{tenant_id}:{user_id}` | string `"<reason>:<expiresAtMs>"`, `EX circuit_breaker_duration_seconds` | `HASH_SCRIPT`, `VELOCITY_SCRIPT` | `pipeline.ts` (plain `GET`) |
| `velocity:{tenant_id}:{user_id}` | sorted set, member `"<requestId>:<cost>"`, score = event time (ms) | `VELOCITY_SCRIPT` | `VELOCITY_SCRIPT` |
| `hashes:{tenant_id}:{user_id}` | list, newest first, capped at 5 | `HASH_SCRIPT` | `HASH_SCRIPT` |

## Testing Strategy

Unit: `VELOCITY_SCRIPT` and `HASH_SCRIPT` run through the same `fengari` Lua VM as `SETTLE_SCRIPT` (window pruning, threshold boundary, already-open guard, five-hash cap, 3-in-a-row match at every position, non-matching runs). `circuit-breaker.ts` functions (retry-after math, hashing determinism, oversized-body exemption). Webhook dispatch retry/backoff/DLQ (mirrors `usage-queue.ts` tests). Migration 006 on PGlite.

Integration: circuit OPEN blocks with 429 + `Retry-After` before budget/hash/provider are touched; three identical requests trip the loop breaker and the third is blocked, not forwarded; a burst of high-cost requests trips the velocity breaker on the request *after* the threshold is crossed; webhook event enqueued exactly once per trip even under duplicate settlement delivery; a tenant with no `webhook_url` never enqueues; oversized body skips hashing but velocity still applies; Redis failure during the circuit read fails open.

## Risks

Reading up to 1 MiB of every request body for hashing is a real latency/memory cost (D1) — this is the biggest departure from Phase 1/2's "never buffer" principle, and is unavoidable given FR-3.3. Sorted-set/list housekeeping (`EXPIRE` on `velocity:*`/`hashes:*`) prevents unbounded growth for abandoned keys, but is best-effort like everything else in Lua scripts run via `EVAL`. Webhook delivery has no signature, so a tenant's endpoint cannot verify the sender (D6, deferred — no secret column exists to sign with).
