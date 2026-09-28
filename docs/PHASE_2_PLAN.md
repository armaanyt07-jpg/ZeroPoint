# Phase 2 Plan: Zero-Lag Dual-Stream Parsing & Asynchronous Ingestion

Status: **approved** (decisions D1-D6 resolved below). Source: `docs/ZeroPoint_SRS_v1.0.pdf`.

## Phase 2 Requirements

| ID | What the SRS says |
| --- | --- |
| FR-2.1 | For a streaming provider response, don't fully buffer it. Duplicate it with `ReadableStream.tee()`. Stream A goes to the client and Stream B is inspected for usage. |
| FR-2.2 | Decode the analytics branch incrementally with `TextDecoder`. Handle partial SSE frames, multiple events per chunk, events split across chunks, provider-specific formats, and terminal `[DONE]` where applicable. |
| FR-2.3 | Usage events go to Cloudflare Queues. Background consumers atomically increment Redis spend and persist durable request metadata (PostgreSQL). |
| FR-2.4 | Each usage event carries a unique `request_id`. Queue retries must not double-count. |
| SRS 8 | A queue failure is retried asynchronously without affecting the client stream. A duplicate settlement is prevented by `request_id`. |
| SRS 9 | Normalize provider usage to one shape. Cost = `input x price + output x price` from versioned pricing. |
| SRS 10 | Redis keys `spend:{tenant}:{user}` and `settled:{request_id}`. |
| SRS 17 | Acceptance: streaming not fully buffered, `tee()` gives an analytics branch, SSE parsing handles arbitrary chunk boundaries, queue settlement is atomic and idempotent. |
| SRS 16 | Unit tests for SSE parsing, cost, adapters. Integration tests for streaming and duplicate queue delivery. |
| NFR-5.1 | Streaming overhead target < 10 ms. |
| NFR-5.2 | No prompt/output persistence. |
| NFR-5.5 | Start emitting `queue_failures`, `streaming_requests`, `token_usage`, `estimated_spend`. |
| NFR-5.6 | Provider logic stays behind the adapter. |
| SRS 15 | Layout hint: `apps/worker/src/streaming/{sse-parser,usage-extractor}.ts`. |

## Current Architecture (Phase 1 hand-off)
- `proxy.ts` `passThrough()` is the only place the upstream body is available: the tee point.
- Adapters' `parseStreamChunk` is a stub; pricing has the formula but no table.
- `RedisClient` has only `get`/`set`; `TenantStore` is read-only; `Telemetry.increment` always adds 1.
- `Dependencies` has no queue and no `waitUntil` (only `Directory` gets it); `wrangler.toml` has no queue bindings.
- `request_logs` and `end_users.current_spend_usd` exist but nothing writes them. `request_id` is generated but not persisted.

## Proposed Changes
Producer (request path): tee in `proxy.ts`; new `streaming/sse-parser.ts` and `streaming/usage-extractor.ts`; adapters gain `extractUsageFromEvent` (and `parseStreamChunk` becomes a wrapper); price table in `packages/pricing`; new `usage-queue.ts`; `deps.ts`/`env.ts`/`pipeline.ts`/`telemetry.ts` extended.

Consumer (same Worker): `queue()` handler in `index.ts`; new `settlement.ts` (Redis step then PostgreSQL step, each idempotent; retry with backoff, DLQ); `redis.ts` gains `eval`; `store.ts` gains an RPC write; migration 005 with `settle_usage()`.

## File/Component Mapping
| Requirement | Files |
| --- | --- |
| FR-2.1 tee | `proxy.ts`, `pipeline.ts`, `deps.ts` |
| FR-2.2 decoder | `streaming/sse-parser.ts`, `streaming/usage-extractor.ts` |
| Provider formats | `packages/providers/src/*` |
| Cost / pricing | `packages/pricing`, `registry.ts`, `packages/types` |
| FR-2.3 produce | `usage-queue.ts`, `env.ts`, `deps.ts`, `wrangler.toml` |
| FR-2.3 consume | `index.ts`, `settlement.ts`, `redis.ts`, `store.ts` |
| FR-2.4 idempotency | Lua script, `settled:{request_id}`, migration 005, `request_logs.request_id UNIQUE` |
| NFR-5.5 | `telemetry.ts`, `proxy.ts`, `settlement.ts` |

## Data Flow
```
Provider 2xx -> body.tee()
  A -> client
  B -> waitUntil: TextDecoder -> SSE parser -> adapter -> usage accumulator
        end/abort: UsageEvent -> USAGE_QUEUE.send (fail -> bounded retry -> queue_failures)
Consumer: Redis EVAL (SET settled NX -> INCRBYFLOAT spend)  then  PG RPC settle_usage
          ack on success; retry(backoff) on failure; DLQ after max_retries
```

## Database / Redis / Queue
- Migration 005: `settle_usage()`; widen `end_users.current_spend_usd` to `NUMERIC(14,8)` (D4).
- Redis: `spend:*` written via `INCRBYFLOAT` (USD); `settled:{request_id}` TTL 15 days (>= max queue retention).
- Queue: producer `USAGE_QUEUE`, consumer on the same Worker, DLQ.

## Decisions
| # | Decision | Outcome |
| --- | --- | --- |
| D1 | Non-streaming JSON responses | **Included** via the same tee; Branch B buffers up to a small cap and parses usage. |
| D2 | OpenAI streaming usage opt-in | **Inject** `stream_options.include_usage` for streaming OpenAI requests only (bounded body read); otherwise `usage_source='unknown'`, cost 0. |
| D3 | Prices | **The SRS specifies no price values.** The price table ships empty; unpriced model => `usage_source='unknown'`, cost 0, telemetry. Nothing invented. |
| D4 | Precision | **Widen** `current_spend_usd` to `NUMERIC(14,8)` in migration 005. |
| D5 | Redis counter rehydration | **Deferred**; known limitation. |
| D6 | Provider error logging | **Settle 2xx only**; error logging deferred. |

## Testing Strategy
Unit: SSE parser at every split offset, per-provider extractors, cost/pricing, privacy (no frame text in events/logs). Integration: byte-identical client output, early first chunk, client abort still drains B, queue failure invisible to client, duplicate delivery = one increment + one row, Redis retry, budget trips after settlement. PGlite: migration 005 + `settle_usage` (duplicate, concurrent, precision). Real runtime: `wrangler dev` smoke test. Not testable: live providers, real Upstash/Supabase, latency target.

## Risks
tee buffering on a slow client; `waitUntil` time limit after disconnect; absent usage; Gemini without `alt=sse`; provider formats verified from knowledge, not the SRS; enforcement lag (SRS-accepted); Redis counter loss (D5); lost events if `queue.send` finally fails; no prices; Lua double-count (tested).

## Phase 3/4 Deferred Work
Phase 3: circuit breaker/state, velocity window, request hashing (`hashes:`), webhooks, `circuit_breaker_events`, `circuit_breaker_*` log columns. Phase 4: dashboard, key provisioning, per-tenant OpenAI org/project, `api_keys.last_used_at`. Unspecified: HALF_OPEN, fail-closed policy, multi-level budgets, load tests, tokenizer for `estimated`.
