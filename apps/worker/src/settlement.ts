import type { UsageEvent, UsageSource } from '@zeropoint/types';
import { spendKey } from './budget';
import type { RedisClient } from './redis';
import { RedisError } from './redis';
import type { UsageStore } from './store';
import type { Telemetry } from './telemetry';

/** SRS section 10: settlement idempotency key. */
export const settledKey = (requestId: string) => `settled:${requestId}`;

/**
 * How long a request stays marked as settled. It must outlive the longest time a
 * queue message can be redelivered (Cloudflare Queues retains messages up to 14
 * days), otherwise a very late retry could be counted twice.
 */
export const SETTLED_TTL_SECONDS = 15 * 24 * 60 * 60;

/**
 * FR-2.3 + FR-2.4, Redis half. One atomic script: mark the request settled ONLY
 * if it isn't already (SET NX), and add its cost to the spend counter only when
 * the mark was newly set. Because it runs as a single Redis operation, a crash or
 * retry can never leave "counted but not marked" or "marked but not counted".
 * KEYS[1] = spend counter, KEYS[2] = settled marker; ARGV[1] = cost (USD), ARGV[2] = marker TTL.
 * Returns 1 when applied, 0 when it was a duplicate.
 */
export const SETTLE_SCRIPT = `
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[2]) then
  redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

/** The dependencies the queue consumer needs. */
export interface SettlementDeps {
  redis: RedisClient;
  store: UsageStore;
  telemetry: Telemetry;
}

export class InvalidUsageEventError extends Error {
  constructor() {
    super('Invalid usage event.');
    this.name = 'InvalidUsageEventError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES: readonly UsageSource[] = ['provider_reported', 'estimated', 'unknown'];

/** Queue bodies are untrusted JSON: check the shape before touching Redis or Postgres. */
export function parseUsageEvent(body: unknown): UsageEvent {
  const e = body as Partial<Record<keyof UsageEvent, unknown>> | null;
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (
    typeof e !== 'object' || e === null ||
    typeof e.requestId !== 'string' || !UUID.test(e.requestId) ||
    typeof e.tenantId !== 'string' || !UUID.test(e.tenantId) ||
    typeof e.externalUserId !== 'string' || e.externalUserId === '' ||
    typeof e.provider !== 'string' || e.provider === '' ||
    !(e.model === null || typeof e.model === 'string') ||
    !isCount(e.statusCode) || !isCount(e.inputTokens) || !isCount(e.outputTokens) ||
    !isCount(e.totalTokens) || !isCount(e.estimatedCostUsd) || !isCount(e.latencyMs) ||
    !SOURCES.includes(e.usageSource as UsageSource) ||
    typeof e.streaming !== 'boolean' ||
    typeof e.occurredAt !== 'string' || Number.isNaN(Date.parse(e.occurredAt))
  ) {
    throw new InvalidUsageEventError();
  }
  return e as UsageEvent;
}

export interface SettlementOutcome {
  /** false = Redis had already counted this request_id. */
  redisApplied: boolean;
  /** false = PostgreSQL had already settled this request_id. */
  databaseApplied: boolean;
}

/**
 * Settles one usage event: Redis, then PostgreSQL. EACH half is idempotent on its
 * own (`settled:{request_id}` in Redis; the UNIQUE request_id inside
 * `settle_usage` in Postgres), so if one half succeeds and the other fails, the
 * queue redelivers the event and the completed half is skipped. Any failure
 * throws so the message is retried, never dropped: this is money, so the Redis
 * fail-open policy (NFR-5.3, for the request path) deliberately does not apply here.
 */
export async function settleUsageEvent(body: unknown, deps: SettlementDeps): Promise<SettlementOutcome> {
  const event = parseUsageEvent(body);

  let redisApplied: boolean;
  try {
    const result = await deps.redis.eval(
      SETTLE_SCRIPT,
      [spendKey(event.tenantId, event.externalUserId), settledKey(event.requestId)],
      [event.estimatedCostUsd.toFixed(8), SETTLED_TTL_SECONDS],
    );
    if (result !== 0 && result !== 1 && result !== '0' && result !== '1') {
      throw new RedisError('Unexpected settlement script result.');
    }
    redisApplied = Number(result) === 1;
  } catch (error) {
    deps.telemetry.increment('redis_failures', { operation: 'settlement' });
    throw error;
  }

  const databaseApplied = await deps.store.settleUsage(event);
  return { redisApplied, databaseApplied };
}

/** The slice of a Cloudflare queue message the consumer uses (so tests can fake it). */
export interface QueueMessageLike {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Retry delay grows 15 s, 30 s, 60 s ... capped at 10 minutes. */
export const retryDelaySeconds = (attempts: number) =>
  Math.min(15 * 2 ** Math.max(0, attempts - 1), 600);

/**
 * Queue consumer entry point (FR-2.3). Each message is settled independently:
 * success -> ack; any failure -> retry with backoff. After the queue's
 * `max_retries` a message moves to the dead-letter queue (wrangler.toml) instead
 * of being lost. A malformed message can never succeed, so it also ends up there.
 */
export async function handleUsageBatch(
  messages: readonly QueueMessageLike[],
  deps: SettlementDeps,
): Promise<void> {
  await Promise.all(
    messages.map(async (message) => {
      try {
        await settleUsageEvent(message.body, deps);
        message.ack();
      } catch (error) {
        deps.telemetry.increment('queue_failures', {
          stage: 'settle',
          reason: error instanceof InvalidUsageEventError ? 'invalid_event' : 'settlement_failed',
        });
        // Only the error type is logged: messages could contain infrastructure detail.
        console.error(JSON.stringify({ type: 'settlement_error', name: (error as Error)?.name, attempts: message.attempts }));
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }),
  );
}
