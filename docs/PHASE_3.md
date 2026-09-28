# Phase 3

## Objective
Runaway Agent Loop Circuit Breaker, the SRS's "WOW" feature (SRS section 3, Phase 3). Two independent protections, both enforced entirely from data in Redis: a 60-second sliding spend window per user (velocity), and SHA-256 hashing of the last five request bodies per user to catch an agent stuck repeating the same call (loop). Either one opens a 15-minute circuit that blocks the user's requests with 429, records the trip, and notifies the tenant's configured webhook. Approved plan: `docs/PHASE_3_PLAN.md`.

## SRS Requirements
| ID | Requirement (summary) |
| --- | --- |
| FR-3.1 | 60-second sliding spend window in Redis sorted sets (`velocity:{tenant}:{user}`); expired entries pruned before summing |
| FR-3.2 | Default $2.00/60s threshold; exceeding it opens the circuit |
| FR-3.3 | SHA-256 hash of a normalized request; last 5 retained (`hashes:{tenant}:{user}`); 3 consecutive matches trip loop detection |
| FR-3.4 | On trigger: circuit -> OPEN, block 15 minutes, record the event, dispatch a developer webhook |
| FR-3.5 | CLOSED/OPEN states, 15-minute expiration; HALF_OPEN explicitly deferred by the SRS |
| FR-3.7 | Webhooks (Queue/Worker) |
| SRS 6.4 | 429 `CIRCUIT_OPEN`, `Retry-After: 900` |
| SRS 7 | Lifecycle: Circuit OPEN? -> Budget Check -> Hash Request -> 3 consecutive? -> Forward |
| NFR-5.5 | `circuit_breaker_events` metric (declared since Phase 1, unused until now) |

## Architecture
```
Request -> authenticate -> pick provider
        -> [end user, spend, circuit state] in parallel (Redis GET x3)
        -> user status (403) -> circuit OPEN? (429, before budget/provider)
        -> budget (429) -> hash request body (clone, <=1 MiB) -> HASH_SCRIPT
             3 consecutive matches -> circuit OPEN, defer record+webhook, 429 (this request is blocked, never forwarded)
        -> forward -> provider -> tee() -> client / usage extraction -> queue

Settlement consumer (Phase 2, extended): after a NEWLY settled event ->
  VELOCITY_SCRIPT (ZADD cost, prune window, sum, threshold) -> if breached: circuit OPEN, record event, queue webhook

Webhook queue (new, separate from the usage queue): dispatch -> consumer POSTs to tenant.webhook_url, retry with backoff, DLQ
```
Key files: `apps/worker/src/circuit-breaker.ts` (Lua scripts, hashing, state read), `apps/worker/src/{pipeline,settlement,pipeline}.ts` (where each check runs), `apps/worker/src/webhook-queue.ts` / `webhook-dispatch.ts` (producer/consumer), `apps/worker/src/{store,auth,deps,env,index}.ts` (tenant policy, wiring), `apps/worker/wrangler.toml` (second queue), `database/migrations/006_circuit_breaker.sql`, `packages/types`.

### Concepts introduced
- **Sliding window via Redis sorted set**: `ZADD` with score = event time; `ZREMRANGEBYSCORE` drops anything older than the window before every read, so "sum of the last 60 seconds" never needs a separate expiry job.
- **Atomic Lua scripts as the whole decision**: `VELOCITY_SCRIPT` and `HASH_SCRIPT` each do their read-modify-write-and-decide in one `EVAL`, the same pattern Phase 2's `SETTLE_SCRIPT` uses, so two requests from the same user racing each other can't both "win" the trip.
- **`Request.clone()` for a second, independent read**: exactly like `ReadableStream.tee()` (Phase 2), `clone()` gives two bodies that can each be read once; the clone's reader must never be awaited on `cancel()` before the other branch is drained, or it hangs forever (hit during development, see D1 below).
- **Fail-open on the request path, never on money**: circuit and hash checks fail open on a Redis error (same NFR-5.3 policy as the budget check); velocity tracking in settlement fails open on ITS OWN error without ever risking the settlement message itself (spend accounting stays correct even if velocity tracking breaks).

## Decisions (not fully specified by the SRS)
See `docs/PHASE_3_PLAN.md` for the full D1-D7 list resolved before implementation (request hashing requires reading the body; circuit value encoding avoids `cjson`; velocity math and member encoding; a new `circuit_breaker_events` audit table; `request_logs.circuit_breaker_triggered/reason` stay unused; webhooks are queued, not sent inline; `HALF_OPEN`/fail-closed are out of scope). One implementation detail surfaced during development, not anticipated in the plan:

- **`reader.cancel()` on a cloned request body must never be awaited.** A `Request.clone()`'s two bodies share one underlying tee; `cancel()` on one branch's reader doesn't resolve until the other branch is also drained or cancelled. `hashRequest`'s bounded reader calls `reader.cancel()` for an oversized body but doesn't await it (`void reader.cancel().catch(() => {})`) — otherwise a body just over the 1 MiB cap would hang the request forever, since the original (unread) branch is only consumed later, by the provider adapter. Caught by an integration test that hung instead of failing.

## Implementation Status
**Completed**: FR-3.1, FR-3.2, FR-3.3, FR-3.4, FR-3.5 (CLOSED/OPEN), FR-3.7, SRS 6.4, SRS 7 lifecycle order, NFR-5.5 (`circuit_breaker_events` now emitted on every trip).

**Not implemented (by design, per the SRS's own text)**:
- `HALF_OPEN` state ("a future HALF_OPEN state may support controlled recovery probes").
- Tenant-level fail-closed policy ("a future tenant-level Fail-Closed policy may be supported").
- Phase 4: dashboard, key provisioning, `api_keys.last_used_at`.
- Unspecified by the SRS: webhook payload signing (no secret column exists), `webhook_dispatched` tracking (no shared id to join a trip to its notification), advanced agent detection (retry/tool-call frequency, execution depth — SRS section "Future Enhancements", explicitly out of scope for Phase 3).

## Tests
`pnpm test`: 385 tests in 22 files (318 from Phase 1/2, unchanged in behaviour; 67 new or extended). New or extended files:

| File | Covers |
| --- | --- |
| `tests/unit/circuit-breaker.test.ts` | `VELOCITY_SCRIPT` and `HASH_SCRIPT` run on the real Lua VM: threshold boundary (`>`, not `>=`), window pruning, the already-open guard (no re-trigger, no webhook flood), 5-hash cap, every 3-in-a-row position; `readCircuitState` (parse, retry-after math, fail-open on error, fail-open on a corrupt value); `checkVelocity`/`checkPatternHash` wrappers; `hashRequest` (determinism, sensitivity to provider/path/body, null body, exact-cap boundary, over-cap exemption, and that an over-cap body is actually cancelled, not silently kept in memory) |
| `tests/unit/webhook-queue.test.ts` | `dispatchWebhookEvent`: success, retry-with-backoff, final failure (logs ids, never the webhook URL) |
| `tests/unit/webhook-dispatch.test.ts` | `parseWebhookEvent` (untrusted queue bodies); `handleWebhookBatch`: ack on 2xx, retry on non-2xx/network error/malformed message, independent per-message outcomes, backoff schedule |
| `tests/unit/settlement.test.ts` (extended) | Velocity tracking end to end through `settleUsageEvent`: opens only once the threshold is crossed, no double-count on duplicate redelivery, webhook enqueued only when `webhook_url` is configured, a lower per-tenant threshold is honored, a failed audit write or missing tenant policy never fails settlement |
| `tests/integration/circuit-breaker.test.ts` | Full pipeline: an already-open circuit blocks before budget/provider with the right `Retry-After`; three identical requests trip the loop breaker and the third is never forwarded; varying bodies never trip it; an over-cap body is exempt even when repeated; a Redis failure during the circuit read fails open; velocity tracked through real settlement opens the circuit for the *next* request; the error body matches SRS 6.4 exactly |
| `tests/unit/clients.test.ts` (extended) | `SupabaseStore.findTenantPolicy` and `.recordCircuitBreakerEvent` request/response shapes and error mapping |
| `tests/unit/migrations.test.ts` (extended) | Migration 006 on PGlite: insert without a pre-existing `end_users` row, `reason` CHECK, cascade delete with the tenant, RLS enabled |
| `tests/lua-redis.ts` (extended) | `EXISTS`, `EXPIRE`, `ZADD`, `ZREMRANGEBYSCORE`, `ZRANGE`, `LPUSH`, `LTRIM`, `LRANGE` added to the test Lua-VM shim, so `VELOCITY_SCRIPT`/`HASH_SCRIPT` run as the exact text that ships, the same principle Phase 2 established for `SETTLE_SCRIPT` |

Also `pnpm typecheck`, `pnpm lint` and `pnpm build:check` pass (the bundle now reports both `USAGE_QUEUE` and `WEBHOOK_QUEUE` bindings).

**Mutation-checked during development** (each of these was hit and fixed, not just imagined): an inclusive-range off-by-one in the test Lua shim's `ZRANGE`/`LRANGE`/`LTRIM` silently dropped the last element of "everything" (`0 -1`), which made the velocity threshold check under-count by exactly one entry; a `checkPatternHash`/`checkVelocity` Redis error path that rethrew instead of failing open turned a Redis outage into a 500 on every request; a test harness bug (reusing one mocked `Response` object across two provider calls) that looked identical to a real stream-locking bug until traced to its stack.

**Not tested**: any live provider; real Upstash (the Lua scripts run on a Lua VM, `fengari`, not real Redis) or real Supabase (the SQL only runs on PGlite); a live webhook endpoint; `waitUntil` time limits in production; NFR-5.1 latency targets with the added body-read cost (D1); a genuine multi-Worker race on the same user (the atomicity relies on Redis `EVAL`, which is correct by construction, but wasn't exercised concurrently against real Redis).

## Known Limitations
- **Every request now clones and reads its body** (up to 1 MiB) to compute a pattern hash. This is a real latency/memory cost that Phase 1/2 deliberately avoided ("never buffer") and is unavoidable given FR-3.3's requirement to hash a normalized request. A body over the cap gets no loop protection (still gets velocity protection).
- **Velocity needs a price.** With the shipped empty price table (Phase 2, D3), every request costs $0, so the velocity breaker can never trip until a tenant's models are priced. Loop detection is unaffected (it doesn't depend on cost).
- **No webhook signature.** The schema has no secret column for a tenant's webhook; a receiving endpoint cannot verify the notification came from ZeroPoint.
- **`HALF_OPEN` and fail-closed are not implemented** — both are explicitly future work in the SRS text itself.
- **The audit trail (`circuit_breaker_events`) is best-effort.** If the insert fails right after Redis opens the circuit, the trip still protects the user (Redis is the enforcement point) but the dashboard-facing record is silently missing; it is never retried.
- **A Redis-state loss (like Phase 2's spend counter) is not repaired.** If `circuit:*`/`velocity:*`/`hashes:*` are lost, protection resets to a clean slate; there is no rebuild path, matching Phase 2's D5 for the spend counter.

## SRS Traceability
| SRS | Implementation | Tests |
| --- | --- | --- |
| FR-3.1 | `circuit-breaker.ts` `VELOCITY_SCRIPT`, `velocityKey` | `circuit-breaker.test.ts`, `settlement.test.ts` |
| FR-3.2 | `VELOCITY_SCRIPT` threshold compare, `TenantPolicy.velocityLimitUsd` | `circuit-breaker.test.ts`, `settlement.test.ts`, `circuit-breaker.test.ts` (integration) |
| FR-3.3 | `HASH_SCRIPT`, `hashRequest`, `pipeline.ts` step 7 | `circuit-breaker.test.ts` (unit + integration) |
| FR-3.4 | `recordAndNotify` (`settlement.ts`), `pipeline.ts`, `store.ts` `recordCircuitBreakerEvent`, migration 006 | `settlement.test.ts`, `circuit-breaker.test.ts` (integration), `migrations.test.ts` |
| FR-3.5 | `circuitKey`, `readCircuitState`, `pipeline.ts` step 5 | `circuit-breaker.test.ts` |
| FR-3.7 | `webhook-queue.ts`, `webhook-dispatch.ts`, `index.ts` `queue()`, `wrangler.toml` | `webhook-queue.test.ts`, `webhook-dispatch.test.ts`, `settlement.test.ts`, `circuit-breaker.test.ts` (integration) |
| SRS 6.4 | `errors.ts` `CIRCUIT_OPEN`, `pipeline.ts` `retry-after` header | `circuit-breaker.test.ts` (integration) |
| SRS 7 | `pipeline.ts` step ordering (circuit -> budget -> hash -> forward) | `circuit-breaker.test.ts` (integration) |
| NFR-5.5 | `telemetry.ts` `circuit_breaker_events` (already declared), tagged by reason | `settlement.test.ts`, `circuit-breaker.test.ts` |
