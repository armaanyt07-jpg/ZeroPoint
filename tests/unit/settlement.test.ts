import { getCurrentSpend, spendKey } from '../../apps/worker/src/budget';
import { circuitKey } from '../../apps/worker/src/circuit-breaker';
import {
  InvalidUsageEventError,
  SETTLED_TTL_SECONDS,
  SETTLE_SCRIPT,
  handleUsageBatch,
  parseUsageEvent,
  retryDelaySeconds,
  settleUsageEvent,
  settledKey,
} from '../../apps/worker/src/settlement';
import type { UsageEvent } from '@zeropoint/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT_POLICY, FakeMessage, FakeRedis, FakeTelemetry, FakeUsageStore, FakeWebhookQueue, TENANT_ID, USER_ID } from '../helpers';

const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  requestId: '22222222-2222-2222-2222-222222222222',
  tenantId: TENANT_ID,
  externalUserId: USER_ID,
  provider: 'openai',
  model: 'gpt-x',
  statusCode: 200,
  inputTokens: 1000,
  outputTokens: 500,
  totalTokens: 1500,
  estimatedCostUsd: 0.002,
  usageSource: 'provider_reported',
  latencyMs: 120,
  streaming: true,
  occurredAt: '2026-09-26T10:00:00.000Z',
  ...overrides,
});

function setup() {
  const redis = new FakeRedis();
  const store = new FakeUsageStore();
  const telemetry = new FakeTelemetry();
  const webhookQueue = new FakeWebhookQueue();
  return { redis, store, telemetry, webhookQueue, deps: { redis, store, telemetry, webhookQueue } };
}
const spendOf = (redis: FakeRedis) => Number(redis.data.get(spendKey(TENANT_ID, USER_ID)));

afterEach(() => vi.restoreAllMocks());

describe('Redis settlement script (FR-2.3 / FR-2.4) - the real Lua text, run on a Lua VM', () => {
  it('adds the cost to spend:{tenant}:{user} and marks settled:{request_id}', async () => {
    const { redis } = setup();
    const result = await redis.eval(SETTLE_SCRIPT, [spendKey(TENANT_ID, USER_ID), settledKey('r1')], ['0.00200000', 60]);
    expect(result).toBe(1);
    expect(spendOf(redis)).toBe(0.002);
    expect(redis.data.get('settled:r1')).toBe('1');
  });

  it('a duplicate request_id changes nothing (returns 0)', async () => {
    const { redis } = setup();
    const run = () => redis.eval(SETTLE_SCRIPT, [spendKey(TENANT_ID, USER_ID), settledKey('r1')], ['0.00200000', 60]);
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    expect(await run()).toBe(0);
    expect(spendOf(redis)).toBe(0.002);
  });

  it('different requests accumulate', async () => {
    const { redis } = setup();
    for (const id of ['a', 'b', 'c']) {
      await redis.eval(SETTLE_SCRIPT, [spendKey(TENANT_ID, USER_ID), settledKey(id)], ['0.50000000', 60]);
    }
    expect(spendOf(redis)).toBe(1.5);
  });

  it('is atomic in one call: the counter is never changed without the marker (single script)', () => {
    // The whole read-modify-write is one EVAL; there is no separate SET/INCR round trip to interleave with.
    expect(SETTLE_SCRIPT.match(/redis\.call/g)).toHaveLength(2);
    expect(SETTLE_SCRIPT).toMatch(/'NX'/);
  });
});

describe('settleUsageEvent', () => {
  it('settles Redis and PostgreSQL once', async () => {
    const { redis, store, deps } = setup();
    expect(await settleUsageEvent(event(), deps)).toEqual({ redisApplied: true, databaseApplied: true });
    expect(spendOf(redis)).toBe(0.002);
    expect(store.logs.size).toBe(1);
  });

  it('duplicate delivery of the same request_id does not double-count in either store (FR-2.4)', async () => {
    const { redis, store, deps } = setup();
    await settleUsageEvent(event(), deps);
    const again = await settleUsageEvent(event(), deps);
    expect(again).toEqual({ redisApplied: false, databaseApplied: false });
    expect(spendOf(redis)).toBe(0.002);
    expect([...store.spend.values()]).toEqual([0.002]);
    expect(store.logs.size).toBe(1);
  });

  it('Redis succeeds, PostgreSQL fails, queue retries: still counted exactly once in each store', async () => {
    const { redis, store, deps } = setup();
    store.failures = 1;
    await expect(settleUsageEvent(event(), deps)).rejects.toThrow();
    expect(spendOf(redis)).toBe(0.002);
    expect(store.logs.size).toBe(0);
    expect(await settleUsageEvent(event(), deps)).toEqual({ redisApplied: false, databaseApplied: true });
    expect(spendOf(redis)).toBe(0.002);
    expect([...store.spend.values()]).toEqual([0.002]);
  });

  it('Redis fails: PostgreSQL is not touched, the error propagates (never fail-open for money) and redis_failures is emitted', async () => {
    const { redis, store, telemetry, deps } = setup();
    redis.evalFailures = 1;
    await expect(settleUsageEvent(event(), deps)).rejects.toThrow();
    expect(store.calls).toBe(0);
    expect(telemetry.count('redis_failures')).toBe(1);
    await settleUsageEvent(event(), deps);
    expect(spendOf(redis)).toBe(0.002);
    expect(store.logs.size).toBe(1);
  });

  it("spend is per tenant and user, and Phase 1's budget check reads what settlement wrote", async () => {
    const { redis, telemetry, deps } = setup();
    const other = '33333333-3333-3333-3333-333333333333';
    await settleUsageEvent(event(), deps);
    await settleUsageEvent(event({ requestId: '44444444-4444-4444-4444-444444444444', estimatedCostUsd: 0.001 }), deps);
    await settleUsageEvent(event({ requestId: '55555555-5555-5555-5555-555555555555', tenantId: other }), deps);
    expect(await getCurrentSpend(redis, telemetry, TENANT_ID, USER_ID)).toBeCloseTo(0.003, 10);
    expect(await getCurrentSpend(redis, telemetry, other, USER_ID)).toBe(0.002);
    expect(await getCurrentSpend(redis, telemetry, TENANT_ID, 'someone_else')).toBe(0);
  });

  it('marks requests as settled for longer than the queue can retain a message (14 days)', async () => {
    const { redis, deps } = setup();
    const spy = vi.spyOn(redis, 'eval');
    await settleUsageEvent(event(), deps);
    expect(spy.mock.calls[0]![2]).toEqual(['0.00200000', SETTLED_TTL_SECONDS]);
    expect(SETTLED_TTL_SECONDS).toBeGreaterThan(14 * 24 * 60 * 60);
  });

  it('a zero-cost (unknown usage) event is still logged and marked settled', async () => {
    const { redis, store, deps } = setup();
    await settleUsageEvent(event({ estimatedCostUsd: 0, usageSource: 'unknown' }), deps);
    expect(spendOf(redis)).toBe(0);
    expect(store.logs.size).toBe(1);
    expect(redis.data.has(settledKey(event().requestId))).toBe(true);
  });
});

describe('parseUsageEvent (queue bodies are untrusted)', () => {
  it('accepts a valid event', () => {
    expect(parseUsageEvent(event())).toEqual(event());
    expect(parseUsageEvent(event({ model: null }))).toBeTruthy();
  });
  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'x'],
    ['bad request id', event({ requestId: 'nope' })],
    ['bad tenant id', event({ tenantId: 'nope' })],
    ['empty user', event({ externalUserId: '' })],
    ['negative cost', event({ estimatedCostUsd: -1 })],
    ['NaN tokens', event({ inputTokens: Number.NaN })],
    ['unknown usage source', event({ usageSource: 'guess' as never })],
    ['non-boolean streaming', event({ streaming: 'yes' as never })],
    ['bad timestamp', event({ occurredAt: 'yesterday' })],
    ['missing field', { ...event(), provider: undefined }],
  ])('rejects %s', (_name, body) => {
    expect(() => parseUsageEvent(body)).toThrow(InvalidUsageEventError);
  });
});

describe('handleUsageBatch (queue consumer)', () => {
  it('acks a settled message', async () => {
    const { deps } = setup();
    const message = new FakeMessage(event());
    await handleUsageBatch([message], deps);
    expect(message.acked).toBe(true);
    expect(message.retried).toBeNull();
  });

  it('retries (does not ack, does not drop) on failure, with backoff, and emits queue_failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, telemetry, deps } = setup();
    store.failures = 1;
    const message = new FakeMessage(event(), 3);
    await handleUsageBatch([message], deps);
    expect(message.acked).toBe(false);
    expect(message.retried).toEqual({ delaySeconds: retryDelaySeconds(3) });
    expect(telemetry.events.find((e) => e.metric === 'queue_failures')?.tags).toMatchObject({ stage: 'settle', reason: 'settlement_failed' });
  });

  it('a malformed message is never settled; it is retried until the dead-letter queue takes it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { redis, store, telemetry, deps } = setup();
    const message = new FakeMessage({ hello: 'world' });
    await handleUsageBatch([message], deps);
    expect(message.acked).toBe(false);
    expect(message.retried).not.toBeNull();
    expect(redis.evalCalls).toBe(0);
    expect(store.calls).toBe(0);
    expect(telemetry.events.find((e) => e.metric === 'queue_failures')?.tags['reason']).toBe('invalid_event');
  });

  it('messages in a batch succeed or fail independently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, deps } = setup();
    store.failures = 1; // exactly one of the two settlements will fail at the database step
    const a = new FakeMessage(event({ requestId: '66666666-6666-6666-6666-666666666666' }));
    const b = new FakeMessage(event({ requestId: '77777777-7777-7777-7777-777777777777' }));
    await handleUsageBatch([a, b], deps);
    expect([a.acked, b.acked].filter(Boolean)).toHaveLength(1);
    expect([a.retried, b.retried].filter(Boolean)).toHaveLength(1);
  });

  it('the failure log has no message contents', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void logged.push(line));
    const { store, deps } = setup();
    store.failures = 1;
    await handleUsageBatch([new FakeMessage(event())], deps);
    expect(logged.join('')).not.toContain(TENANT_ID);
    expect(logged.join('')).not.toContain(USER_ID);
  });

  it('backoff grows and is capped', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelaySeconds)).toEqual([15, 30, 60, 120, 240, 480, 600, 600]);
  });
});

describe('settleUsageEvent tracks velocity and trips the breaker (FR-3.1/3.2/3.4)', () => {
  it('opens the circuit once cumulative cost within the window exceeds the threshold', async () => {
    const { redis, store, deps } = setup();
    await settleUsageEvent(event({ requestId: '88888888-8888-8888-8888-888888888888', estimatedCostUsd: 1.5 }), deps);
    expect(redis.data.has(circuitKey(TENANT_ID, USER_ID))).toBe(false);
    await settleUsageEvent(event({ requestId: '99999999-9999-9999-9999-999999999999', estimatedCostUsd: 1.5 }), deps);
    expect(redis.data.get(circuitKey(TENANT_ID, USER_ID))).toMatch(/^velocity:\d+$/);
    expect(store.circuitBreakerEvents).toEqual([
      { tenantId: TENANT_ID, externalUserId: USER_ID, reason: 'velocity', openedAt: expect.any(String), expiresAt: expect.any(String) },
    ]);
  });

  it('emits circuit_breaker_events telemetry only on the trip, not on every settle', async () => {
    const { telemetry, deps } = setup();
    await settleUsageEvent(event({ requestId: '11111111-2222-3333-4444-555555555555', estimatedCostUsd: 1.5 }), deps);
    expect(telemetry.count('circuit_breaker_events')).toBe(0);
    await settleUsageEvent(event({ requestId: '22222222-3333-4444-5555-666666666666', estimatedCostUsd: 1.5 }), deps);
    expect(telemetry.count('circuit_breaker_events')).toBe(1);
  });

  it('does not double-count velocity on a duplicate redelivery', async () => {
    const { redis, deps } = setup();
    const e = event({ requestId: '33333333-4444-5555-6666-777777777777', estimatedCostUsd: 3 }); // alone, over threshold
    await settleUsageEvent(e, deps); // first delivery: trips
    redis.data.delete(circuitKey(TENANT_ID, USER_ID)); // simulate the circuit having since closed
    await settleUsageEvent(e, deps); // redelivery: redisApplied=false, must not re-track
    expect(redis.data.has(circuitKey(TENANT_ID, USER_ID))).toBe(false);
  });

  it('dispatches a webhook only when the tenant has webhook_url configured', async () => {
    const { store, webhookQueue, deps } = setup();
    store.policies.set(TENANT_ID, { ...DEFAULT_TENANT_POLICY, webhookUrl: 'https://tenant.example/hook' });
    await settleUsageEvent(event({ requestId: '44444444-5555-6666-7777-888888888888', estimatedCostUsd: 3 }), deps);
    expect(webhookQueue.sent).toEqual([
      {
        tenantId: TENANT_ID,
        externalUserId: USER_ID,
        webhookUrl: 'https://tenant.example/hook',
        reason: 'velocity',
        openedAt: expect.any(String),
        expiresAt: expect.any(String),
      },
    ]);
  });

  it('no webhook_url configured (the default): nothing is queued', async () => {
    const { webhookQueue, deps } = setup();
    await settleUsageEvent(event({ requestId: '55555555-6666-7777-8888-999999999999', estimatedCostUsd: 3 }), deps);
    expect(webhookQueue.sent).toHaveLength(0);
  });

  it('a lower per-tenant velocity_limit_usd is honored', async () => {
    const { redis, store, deps } = setup();
    store.policies.set(TENANT_ID, { ...DEFAULT_TENANT_POLICY, velocityLimitUsd: 0.01 });
    await settleUsageEvent(event({ requestId: '66666666-7777-8888-9999-aaaaaaaaaaaa', estimatedCostUsd: 0.02 }), deps);
    expect(redis.data.has(circuitKey(TENANT_ID, USER_ID))).toBe(true);
  });

  it('a failure recording the audit event never fails settlement (best-effort, D4)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, deps } = setup();
    store.recordCircuitBreakerEvent = async () => {
      throw new Error('db down');
    };
    await expect(
      settleUsageEvent(event({ requestId: '77777777-8888-9999-aaaa-bbbbbbbbbbbb', estimatedCostUsd: 3 }), deps),
    ).resolves.toEqual({ redisApplied: true, databaseApplied: true });
  });

  it('a missing tenant policy row never throws (settlement stays correct; velocity is just skipped)', async () => {
    const { store, deps } = setup();
    store.findTenantPolicy = async () => null;
    await expect(
      settleUsageEvent(event({ requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), deps),
    ).resolves.toEqual({ redisApplied: true, databaseApplied: true });
  });
});
