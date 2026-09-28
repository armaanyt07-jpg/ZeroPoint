# Phase 2

## Objective
Zero-Lag Dual-Stream Parsing & Asynchronous Ingestion (SRS section 3, Phase 2). Provider responses are duplicated with `ReadableStream.tee()`: one branch goes to the client untouched, the other is decoded in the background to extract token usage. A usage event is put on a Cloudflare Queue, and a consumer settles it into Redis (real-time spend) and PostgreSQL (durable log), idempotently by `request_id`. Approved plan: `docs/PHASE_2_PLAN.md`.

## SRS Requirements
| ID | Requirement (summary) |
| --- | --- |
| FR-2.1 | `tee()`: Stream A to the client, Stream B inspected for usage; no full buffering |
| FR-2.2 | Incremental `TextDecoder` SSE decoding: partial frames, several events per chunk, events split across chunks, provider formats, `[DONE]` |
| FR-2.3 | Usage events to Cloudflare Queues; background consumers atomically increment Redis spend and persist request metadata |
| FR-2.4 | Unique `request_id` per event; retries never double-count |
| SRS 8 | Queue failure retried asynchronously without affecting the client stream; duplicate settlement prevented by `request_id` |
| SRS 9 / 10 / 11 | Cost formula and normalized usage; Redis keys `spend:*` and `settled:*`; queue + consumer architecture |
| NFR-5.2 | No prompt/output persistence |
| NFR-5.5 | `streaming_requests`, `token_usage`, `estimated_spend`, `queue_failures` now emitted |
| SRS 17 (Phase 2) | Not fully buffered; `tee()` gives an analytics branch; SSE parsing handles arbitrary chunk boundaries; settlement is atomic and idempotent |

## Architecture
```
Client -> Worker (Phase 1 pipeline, unchanged up to the forward)
Provider 2xx response -> body.tee()   (proxy.ts passThrough)
  Stream A ------------------------------------------------> client (allow-listed headers, x-request-id)
  Stream B -> ctx.waitUntil( trackUsage )            streaming/usage-extractor.ts
       SseParser (TextDecoder stream:true) -> adapter.extractUsage(JSON) -> merge (latest cumulative value wins)
       -> UsageEvent (metadata only) -> USAGE_QUEUE.send  (3 attempts, backoff; queue_failures on failure)
Queue consumer (same Worker, index.ts queue()):  settlement.ts, per message
  1. Redis EVAL SETTLE_SCRIPT:  SET settled:{request_id} NX EX 15d  ->  only if new: INCRBYFLOAT spend:{tenant}:{user}
  2. Postgres RPC settle_usage(): upsert end_user, INSERT request_logs ON CONFLICT (request_id) DO NOTHING,
     add cost to end_users.current_spend_usd only if the row was inserted  (one transaction)
  ack on success | retry(delay 15 s x 2^n, max 10 min) on any failure | dead-letter queue after max_retries
```
Key files: `apps/worker/src/{proxy,pipeline,deps,env,index,redis,store,settlement,usage-queue,telemetry}.ts`, `apps/worker/src/streaming/{sse-parser,usage-extractor}.ts`, `packages/providers/src/{sse-parser,usage,shared,adapter,openai,anthropic,gemini,registry}.ts`, `packages/pricing`, `packages/types`, `database/migrations/005_settlement.sql`, `apps/worker/wrangler.toml`.

### Concepts introduced
- **`ReadableStream.tee()`**: splits one stream into two independent branches. Chunks are pulled as consumers read, never all at once. If one branch is slow, the tee queues chunks for it in memory. Note: a branch's `cancel()` promise only settles once *both* branches are done, so nobody should `await` it (the runtime does not).
- **Incremental decoding**: `TextDecoder` with `{stream: true}` keeps a partial multi-byte character until the rest arrives; `SseParser` keeps a partial line/frame. Both hold only what is unfinished, never the whole stream.
- **Cumulative usage**: providers report totals that grow (Anthropic sends input tokens first and output tokens last), so merging keeps the latest value per field and never lets a later event that omits a field erase it.
- **Queue + at-least-once delivery**: a queue may deliver a message more than once, so consumers must be idempotent. Two independent guards (Redis marker, Postgres unique `request_id`) mean a retry after a half-finished attempt never double-counts in either store.
- **Lua script (Redis `EVAL`)**: runs as one atomic operation, so "mark settled" and "add to counter" can never be split apart by a crash or a competing consumer.
- **Dead-letter queue**: where a message goes after `max_retries`, so it is kept for inspection rather than lost.

## Decisions (not fully specified by the SRS)
1. **D1: non-streaming JSON responses are settled too.** SRS 2.1 shows "SSE / JSON Response" and 1.1 says usage is tracked for requests; without this, non-streaming calls would never accrue spend. They go through the same `tee()`; Branch B buffers the body up to 2 MiB and parses it once. A larger body is drained but not inspected (usage unknown). Mode is chosen from the *response* `content-type` (`text/event-stream` = SSE), so the request body is not needed for that decision.
2. **D2: OpenAI streaming usage opt-in.** OpenAI only reports usage on a stream when the request has `stream_options.include_usage: true`. For `stream: true` requests the adapter reads the request body (up to 1 MiB) and sets it (overriding an explicit `false`, since governance needs the numbers). Costs: the request is buffered before forwarding, and OpenAI appends one extra final chunk (empty `choices`, populated `usage`) to the client's stream. Non-streaming requests, non-JSON bodies, bodies over the cap and requests already opted in are forwarded byte-for-byte. Anthropic and Gemini report usage without any opt-in and are untouched.
3. **D3: no prices.** The SRS specifies the price *model* (section 9) but no price *values*, so `DEFAULT_PRICING` in `packages/pricing` is empty and nothing was invented. Every model is therefore "unpriced": the request is still logged with its token counts, but `estimated_cost_usd = 0` and `usage_source = 'unknown'`. `provider_reported` is used only when both token counts were reported AND the model has a price. No token estimator was built (`'estimated'` is never produced). To enable enforcement, add entries to `DEFAULT_PRICING` (or pass a table to `createDefaultRegistry(pricing)`) and bump `PRICING_VERSION`. **Until prices are configured, spend stays 0 and the 429 budget guardrail cannot trigger from settled usage.**
4. **D4: `end_users.current_spend_usd` widened to `NUMERIC(14,8)`** (migration 005). The SRS column has 4 decimals; a typical request costs about $0.00003, so adding each cost to it would round to zero and silently under-count. It now matches `request_logs.estimated_cost_usd`.
5. **D5: no Redis counter rehydration.** If Redis loses `spend:*`, spend reads as 0 until new settlements accumulate; Postgres keeps the true value. The SRS defines no rebuild; deferred.
6. **D6: only 2xx responses are settled.** Provider errors, rejected requests (401/403/429) and 5xx produce no usage event or log row. Error logging is deferred.
7. **`parseStreamChunk` and the adapter interface.** A stateless `parseStreamChunk(chunk)` cannot handle a frame split across chunks, so SSE decoding lives in `SseParser` (provider-agnostic) and adapters implement `extractUsage(payload)` (one parsed JSON object -> normalized usage), plus an optional `modelFromPath` (Gemini's model is in the URL). `parseStreamChunk` remains, implemented as a one-shot convenience for a complete chunk. `SseParser` sits in `packages/providers` (the adapters need it) and is re-exported from `apps/worker/src/streaming/sse-parser.ts` to match SRS section 15.
8. **SSE parser leniency.** The SSE spec discards an unterminated final frame at EOF; `end()` delivers it instead, because a lost last frame is lost accounting. A single line longer than 1 MiB is dropped (`overflowed`) so memory stays bounded.
9. **Provider usage mapping** (from provider API knowledge, not the SRS; verify against current provider docs). OpenAI: `usage.prompt_tokens` / `completion_tokens` on the last chunk. Anthropic: `message_start.message.usage.input_tokens` and cumulative `message_delta.usage.output_tokens`. Gemini: `usageMetadata.promptTokenCount` as input, `candidatesTokenCount + thoughtsTokenCount` as output; model from `modelVersion`, else the URL. Cached/reasoning breakdowns are not priced separately (the SRS has one input and one output price). Gemini streaming without `?alt=sse` returns a JSON array, which is handled as a JSON body (size-capped).
10. **What `usage_source` means.** `provider_reported` = counts came from the provider and were priced. `unknown` = anything else. A client that disconnects mid-stream still has Stream B drained; if the provider's final usage frame arrives it is counted.
11. **Fields.** `latency_ms` = Worker start to end of provider stream (`Date.now()`, which on Workers only advances on I/O, so approximate). `status_code` = provider status. `streaming` = response was `text/event-stream`. `created_at` = request start, not settlement time. `circuit_breaker_*` keep their defaults (Phase 3).
12. **Settlement never fails open.** NFR-5.3 (fail-open) protects the request path. A Redis or database error in the consumer throws, and the message is retried with backoff; after `max_retries` (10) it goes to the dead-letter queue. A malformed message is retried to the DLQ too (it can never succeed, but it is preserved).
13. **Producer failure.** `queue.send` is retried 3 times (50 ms, 100 ms) inside `waitUntil`, off the client path. If all attempts fail the event is lost (the SRS defines no fallback): `queue_failures` (`final=true`) and a `usage_event_lost` log line with ids and numbers only.
14. **`USAGE_QUEUE` is a required binding.** A missing binding is a configuration error: `/health` returns 503 and proxy requests return 500 `CONFIGURATION_ERROR`, rather than silently dropping settlement. Existing tests that build a raw `env` gained this binding.
15. **`Telemetry.increment(metric, tags, value = 1)`**: the optional `value` carries token counts (`token_usage`) and USD (`estimated_spend`); tags are provider and usage source only.
16. **Settlement idempotency TTL** is 15 days, longer than the 14 days Cloudflare Queues retains a message, so a very late redelivery cannot be double-counted.
17. **`settle_usage` is service-role only.** Postgres functions are executable by PUBLIC by default and Supabase exposes them at `/rest/v1/rpc/...` to the public anon key (RLS does not protect them). Migration 005 revokes PUBLIC/anon/authenticated and grants `service_role`; the role checks are conditional so the same file runs on plain PostgreSQL (PGlite in tests).
18. **Cost rounding**: `calculateCostUsd` rounds to 8 decimals (ledger precision).
19. **Deployment**: create the queues once (`wrangler queues create zeropoint-usage` and `zeropoint-usage-dlq`) and apply migration 005 before deploying. The Worker exports both `fetch` and `queue`.

## Implementation Status
**Completed**: FR-2.1, FR-2.2, FR-2.3, FR-2.4, SRS 8 queue failure and duplicate settlement rows, NFR-5.5 metrics (`streaming_requests`, `token_usage`, `estimated_spend`, `queue_failures`), migration 005.

**Not implemented (by design)**:
- Phase 3: circuit breaker and state, `velocity:*` window, request hashing (`hashes:*`), webhooks, `circuit_breaker_events`, `circuit_breaker_*` log columns (left at defaults).
- Phase 4: dashboard, key provisioning, `api_keys.last_used_at`, per-tenant OpenAI org/project.
- Unspecified by the SRS: price values (D3), a token estimator, Redis counter rehydration (D5), logging of provider errors (D6), reservations for in-flight spend, `HALF_OPEN`, fail-closed policy, load tests (SRS 16.3).

## Tests
`pnpm test`: 318 tests in 18 files (187 from Phase 1, all unchanged in behaviour; 131 new). New or extended files:

| File | Covers |
| --- | --- |
| `tests/unit/sse-parser.test.ts` | Every 2-way split offset, byte-at-a-time, 300 seeded random chunkings, CRLF and lone-CR splits, multi-byte characters split mid-character, unterminated final frame, comments, `event` scoping, buffer cap, no text retained |
| `tests/unit/usage-extraction.test.ts` | OpenAI/Anthropic/Gemini fixtures split at every offset, provider extractors and junk input, upstream error mid-stream, JSON mode and its size cap, `buildUsageEvent` (priced/unpriced/no usage/partial), no-invented-prices guard, cost rounding, metadata-only event |
| `tests/unit/openai-stream-optin.test.ts` | D2: opt-in for `stream:true`, unchanged bytes for everything else, over-cap replay, proxy key still replaced |
| `tests/unit/settlement.test.ts` | The real Lua script (run on `fengari`, a Lua VM in JS): apply, duplicate, accumulate; two-store idempotency incl. "Redis done, DB failed, retry"; Redis failure never fails open; per-tenant spend read back by Phase 1's `getCurrentSpend`; TTL > 14 days; event validation; consumer ack/retry/backoff/poison messages |
| `tests/integration/streaming.test.ts` | Byte-identical client stream; first chunk before the provider finishes; client disconnect still drains Stream B; split chunks; Anthropic and Gemini end to end; JSON responses; unpriced models; OpenAI opt-in reaches the provider; queue failure (transient and permanent) invisible to the client; no event for 401/429/provider errors; privacy (no prompt/output text in events, logs or telemetry); request -> queue -> settle -> next request 429; duplicate delivery counted once; `queue()` entry point; missing binding |
| `tests/unit/migrations.test.ts` (extended) | Migration 005 on PGlite: column precision, insert + spend once, duplicate and "concurrent" redelivery, tenant/user isolation, existing user preserved, null model, CHECK still enforced, function not executable by PUBLIC |
| `tests/unit/clients.test.ts` (extended) | `EVAL` and `settle_usage` RPC request shapes and error mapping |
| `tests/helpers.ts`, `tests/lua-redis.ts` | `FakeUsageQueue`, `FakeUsageStore`, `FakeRedis.eval` (runs the real script), `sseResponse`, `FakeMessage` |

Also `pnpm typecheck`, `pnpm lint` and `pnpm build:check` pass (the bundle now reports the `USAGE_QUEUE` binding).

**Mutation-checked**: removing `NX` from the script, removing the `\r`-at-chunk-end wait, dropping `stream:true` in `TextDecoder`, removing the SQL "already inserted" guard, reverting the column to `NUMERIC(12,4)`, breaking the usage prefilter, skipping the tee, not draining Stream B, skipping the DB half, acking instead of retrying, skipping the OpenAI opt-in, and letting a queue failure surface: each makes tests fail.

**Verified in the real Workers runtime** (`workerd` via `wrangler dev`, real Queues, a local mock of Upstash/Supabase, and a synthetic slow SSE provider): chunks reached the client incrementally (0.02 s, 0.42 s, 0.82 s, 1.23 s), one usage event was queued and consumed, Redis and the database were each settled once (spend 0.002), and a client that disconnected after the first chunk was still fully settled.

**Not tested**: any live provider; real Upstash (the Lua is executed on a Lua VM, not real Redis) or real Supabase (the SQL only runs on PGlite); `waitUntil` time limits and memory in production; the latency targets (NFR-5.1); load (SRS 16.3).

## Known Limitations
- **No prices are configured (D3)**, so out of the box every request is logged with cost 0 and spend never grows; budgets do not trip until a price table is supplied.
- Provider formats (D2, decision 9) come from provider API knowledge and were tested only against fixtures. Verify before relying on them.
- OpenAI streaming requests are buffered (up to 1 MiB) before forwarding, and clients see one extra final chunk.
- Aborted streams may lack the provider's final usage (Anthropic reports output tokens at the end), so they can be under-counted.
- Spend is eventually consistent: requests in flight before settlement are not counted (SRS 18, "Queue delay"). No reservations.
- If `queue.send` fails 3 times the usage event is lost (logged for reconciliation).
- `tee()` buffers in memory for a slow client; the Streams spec gives no bound. Very long `waitUntil` tails after a disconnect may be cut off by the platform (limit not verified).
- Redis `spend:*` is a floating-point USD counter (`INCRBYFLOAT`); Postgres is exact to 8 decimals. Loss of the Redis counter is not repaired (D5).
- Cached-input and reasoning-token price differences are not modelled.
- PGlite is single-connection, so the "concurrent" settlement test is serialized; real concurrency safety rests on the `UNIQUE (request_id)` index and `ON CONFLICT DO NOTHING`.
- `latency_ms` is approximate (Workers clock).

## SRS Traceability
| SRS | Implementation | Tests |
| --- | --- | --- |
| FR-2.1 | `proxy.ts` `passThrough` (`tee`), `streaming/usage-extractor.ts` `trackUsage`, `deps.ts` `defer` | `streaming.test.ts` "dual-stream piping" |
| FR-2.2 | `packages/providers/src/sse-parser.ts`, `usage.ts`, adapters `extractUsage` | `sse-parser.test.ts`, `usage-extraction.test.ts` |
| FR-2.3 | `usage-queue.ts`, `index.ts` `queue()`, `settlement.ts`, `redis.ts` `eval`, `store.ts` `settleUsage`, migration 005, `wrangler.toml` | `settlement.test.ts`, `streaming.test.ts`, `migrations.test.ts`, `clients.test.ts` |
| FR-2.4 | `SETTLE_SCRIPT` (`settled:{request_id}`), `settle_usage()` (`request_logs.request_id UNIQUE`) | `settlement.test.ts`, `migrations.test.ts`, `streaming.test.ts` "duplicate queue delivery" |
| SRS 8 (queue failure, duplicates) | `usage-queue.ts`, `settlement.ts` retry/DLQ | `streaming.test.ts` "queue failures never affect the client", `settlement.test.ts` |
| SRS 9 | `packages/pricing`, adapters `calculateCost`, `buildUsageEvent` | `usage-extraction.test.ts` |
| SRS 10 | `settlement.ts` `settledKey`, `budget.ts` `spendKey` | `settlement.test.ts` |
| NFR-5.2 | events carry metadata only; parser keeps no text; logs carry ids only | `streaming.test.ts` "privacy", `usage-extraction.test.ts` |
| NFR-5.5 | `telemetry.ts` (value), `usage-extractor.ts`, `settlement.ts` | `streaming.test.ts` |
| SRS 17 (Phase 2) | all of the above | `streaming.test.ts` and the workerd run |
