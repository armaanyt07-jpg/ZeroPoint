import type { CircuitBreakerReason, TenantPolicy } from '@zeropoint/types';
import type { RedisClient } from './redis';
import type { Telemetry } from './telemetry';

/** Redis keys (SRS section 10). Always tenant-scoped, like `spendKey` (budget.ts). */
export const circuitKey = (tenantId: string, userId: string) => `circuit:${tenantId}:${userId}`;
export const velocityKey = (tenantId: string, userId: string) => `velocity:${tenantId}:${userId}`;
export const hashesKey = (tenantId: string, userId: string) => `hashes:${tenantId}:${userId}`;

/** Largest request body read to compute a pattern hash (FR-3.3). Same cap as Phase 2's D2. */
export const MAX_HASHED_REQUEST_BYTES = 1024 * 1024;

/** How many hashes are retained per user (FR-3.3: "the last five"). */
const HASH_HISTORY_SIZE = 5;

/** Extra seconds of headroom before a housekeeping key (velocity/hashes) is left to expire. */
const HOUSEKEEPING_BUFFER_SECONDS = 5;

export interface CircuitState {
  open: boolean;
  reason?: CircuitBreakerReason;
  /** Seconds until the circuit closes again. Present only when `open`. */
  retryAfterSeconds?: number;
}

/** Result of a check that can newly open the circuit. `null` = no trigger (or already open). */
export interface CircuitTrigger {
  reason: CircuitBreakerReason;
  openedAt: string;
  expiresAt: string;
}

/**
 * FR-3.1/3.2, Redis half. One atomic script per settled request:
 *   1. Record this request's cost in the 60-second (configurable) sliding window.
 *   2. Prune entries older than the window.
 *   3. If the circuit is already open, stop (D3: never re-trigger mid-block).
 *   4. Sum what remains; if it EXCEEDS the tenant's threshold, open the circuit.
 * Sorted-set members are "requestId:cost" (score = event time in ms) so ZADD on the
 * same request can never collide with a different one, while `string.match` can still
 * recover the cost of every surviving member to sum.
 * KEYS[1] = velocity zset, KEYS[2] = circuit key.
 * ARGV: 1=now_ms 2=window_ms 3=cost 4=request_id 5=threshold_usd 6=circuit_ttl_s
 *       7=expires_at_ms 8=reason 9=zset_housekeeping_ttl_s
 * Returns 1 if this call opened the circuit, 0 otherwise.
 */
export const VELOCITY_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4] .. ':' .. ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tostring(tonumber(ARGV[1]) - tonumber(ARGV[2])))
redis.call('EXPIRE', KEYS[1], ARGV[9])
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local total = 0
for i = 1, #members do
  local cost = string.match(members[i], ':([%d%.]+)$')
  total = total + tonumber(cost)
end
if total > tonumber(ARGV[5]) then
  redis.call('SET', KEYS[2], ARGV[8] .. ':' .. ARGV[7], 'EX', ARGV[6])
  return 1
end
return 0
`;

/**
 * FR-3.3, Redis half. One atomic script per request:
 *   1. Push the new hash, trim to the last five (FR-3.3).
 *   2. If the circuit is already open, stop.
 *   3. If the three most recent hashes are all identical, open the circuit.
 * KEYS[1] = hashes list, KEYS[2] = circuit key.
 * ARGV: 1=hash 2=list_housekeeping_ttl_s 3=circuit_ttl_s 4=expires_at_ms 5=reason
 * Returns 1 if this call opened the circuit, 0 otherwise.
 */
export const HASH_SCRIPT = `
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, ${HASH_HISTORY_SIZE - 1})
redis.call('EXPIRE', KEYS[1], ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
local top = redis.call('LRANGE', KEYS[1], 0, 2)
if #top == 3 and top[1] == top[2] and top[2] == top[3] then
  redis.call('SET', KEYS[2], ARGV[5] .. ':' .. ARGV[4], 'EX', ARGV[3])
  return 1
end
return 0
`;

/**
 * Reads the circuit state (FR-3.5). Fails OPEN on a Redis error (NFR-5.3, same policy
 * as `getCurrentSpend` in budget.ts): a governance outage must never take a customer's
 * app offline. The circuit value is "<reason>:<expiresAtEpochMs>" (D2: no `cjson`
 * dependency); `retryAfterSeconds` is derived from the embedded timestamp rather than
 * Redis TTL, which is both one round trip cheaper and immune to clock-sweep skew.
 */
export async function readCircuitState(
  redis: RedisClient,
  telemetry: Telemetry,
  tenantId: string,
  userId: string,
): Promise<CircuitState> {
  let raw: string | null;
  try {
    raw = await redis.get(circuitKey(tenantId, userId));
  } catch {
    telemetry.increment('redis_failures', { operation: 'circuit_read', outcome: 'fail_open' });
    return { open: false };
  }
  if (raw === null) return { open: false };

  const separator = raw.lastIndexOf(':');
  const reason = separator === -1 ? null : raw.slice(0, separator);
  const expiresAtMs = separator === -1 ? NaN : Number(raw.slice(separator + 1));
  if ((reason !== 'velocity' && reason !== 'loop') || !Number.isFinite(expiresAtMs)) {
    // Corrupt value: treat like a Redis failure and fail open rather than trust garbage.
    telemetry.increment('redis_failures', { operation: 'circuit_read', outcome: 'fail_open' });
    return { open: false };
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));
  return { open: true, reason, retryAfterSeconds };
}

/**
 * Encodes the atomic velocity check (FR-3.1/3.2). Fails OPEN on a Redis error
 * (NFR-5.3): a burst that can't be measured is simply not protected against this
 * time, rather than turning a governance outage into a failed settlement message.
 */
export async function checkVelocity(
  redis: RedisClient,
  telemetry: Telemetry,
  tenantId: string,
  userId: string,
  requestId: string,
  costUsd: number,
  occurredAtMs: number,
  policy: TenantPolicy,
): Promise<CircuitTrigger | null> {
  const windowMs = policy.velocityWindowSeconds * 1000;
  const expiresAtMs = occurredAtMs + policy.circuitBreakerDurationSeconds * 1000;
  let opened: unknown;
  try {
    opened = await redis.eval(
      VELOCITY_SCRIPT,
      [velocityKey(tenantId, userId), circuitKey(tenantId, userId)],
      [
        occurredAtMs,
        windowMs,
        costUsd.toFixed(8),
        requestId,
        policy.velocityLimitUsd.toFixed(8),
        policy.circuitBreakerDurationSeconds,
        expiresAtMs,
        'velocity',
        policy.velocityWindowSeconds + HOUSEKEEPING_BUFFER_SECONDS,
      ],
    );
  } catch {
    telemetry.increment('redis_failures', { operation: 'velocity_check', outcome: 'fail_open' });
    return null;
  }
  if (Number(opened) !== 1) return null;
  return { reason: 'velocity', openedAt: new Date(occurredAtMs).toISOString(), expiresAt: new Date(expiresAtMs).toISOString() };
}

/**
 * Encodes the atomic pattern-hash check (FR-3.3). Fails OPEN on a Redis error
 * (NFR-5.3): this runs on the request's critical path, same as the budget check,
 * so a Redis outage must let the request through rather than 500 it.
 */
export async function checkPatternHash(
  redis: RedisClient,
  telemetry: Telemetry,
  tenantId: string,
  userId: string,
  hash: string,
  nowMs: number,
  policy: TenantPolicy,
): Promise<CircuitTrigger | null> {
  const expiresAtMs = nowMs + policy.circuitBreakerDurationSeconds * 1000;
  let opened: unknown;
  try {
    opened = await redis.eval(
      HASH_SCRIPT,
      [hashesKey(tenantId, userId), circuitKey(tenantId, userId)],
      [
        hash,
        policy.circuitBreakerDurationSeconds + HOUSEKEEPING_BUFFER_SECONDS,
        policy.circuitBreakerDurationSeconds,
        expiresAtMs,
        'loop',
      ],
    );
  } catch {
    telemetry.increment('redis_failures', { operation: 'hash_check', outcome: 'fail_open' });
    return null;
  }
  if (Number(opened) !== 1) return null;
  return { reason: 'loop', openedAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiresAtMs).toISOString() };
}

/**
 * FR-3.3's "normalized request representation": provider + path + body, hashed with
 * SHA-256. Reads at most `maxBytes` of `body` (D1) and returns null if the body is
 * larger (exempt from hash tracking rather than partially/never hashed, so an
 * oversized payload can never be silently treated as identical to another).
 */
export async function hashRequest(
  providerId: string,
  pathname: string,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_HASHED_REQUEST_BYTES,
): Promise<string | null> {
  const bodyBytes = await readBounded(body, maxBytes);
  if (bodyBytes === null) return null;
  const prefix = new TextEncoder().encode(`${providerId}\n${pathname}\n`);
  const combined = new Uint8Array(prefix.byteLength + bodyBytes.byteLength);
  combined.set(prefix, 0);
  combined.set(bodyBytes, prefix.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads a stream fully if it's within `maxBytes`, else cancels it and returns null.
 *
 * `body` is one branch of a `Request.clone()` (D1): its `cancel()` promise only
 * settles once the OTHER branch (the one the adapter will read later) is also
 * done, exactly like a `tee()` branch (docs/PHASE_2.md's `ReadableStream.tee()`
 * note) — so it must never be awaited, or an oversized body would hang forever.
 */
async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
