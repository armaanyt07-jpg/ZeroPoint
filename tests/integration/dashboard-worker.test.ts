import { createDefaultRegistry } from '@zeropoint/providers';
import { PRICING_CACHE_KEY, lastUsedKey } from '@zeropoint/schemas';
import type { ModelPricing } from '@zeropoint/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAST_USED_THROTTLE_SECONDS, recordKeyUse } from '../../apps/worker/src/auth';
import { handleProxyRequest } from '../../apps/worker/src/pipeline';
import { createHarness, FakeRedis, FakeStore, FakeTelemetry, proxyRequest, type Harness } from '../helpers';

/** Test-only prices (NOT real prices): $1 per million input tokens, $2 per million output. */
const DB_PRICE: ModelPricing = { provider: 'openai', model: 'fixture-mini', inputPerMillionTokens: 1, outputPerMillionTokens: 2 };

/** A non-streaming OpenAI answer reporting a dated snapshot, as OpenAI does. */
const jsonAnswer = (model = 'fixture-mini-2024-07-18') =>
  new Response(JSON.stringify({ model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } }), {
    headers: { 'content-type': 'application/json' },
  });

async function send(h: Harness, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    h.providerFetch.mockResolvedValueOnce(jsonAnswer());
    // Distinct bodies: three identical requests would (correctly) trip the loop breaker.
    const res = await handleProxyRequest(proxyRequest({ body: `{"model":"fixture-mini","messages":[],"n":${i}}` }), h.deps);
    expect(res.status).toBe(200);
    await res.text();
    await h.flush();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('dashboard-managed prices (Phase 4, D9)', () => {
  it('prices a dated snapshot with the administrator-entered family price', async () => {
    const h = await createHarness();
    h.store.prices = [DB_PRICE];
    await send(h);
    expect(h.queue.sent[0]).toMatchObject({ model: 'fixture-mini-2024-07-18', usageSource: 'provider_reported', estimatedCostUsd: 0.002 });
  });

  it('the database price wins over the static table', async () => {
    const h = await createHarness();
    h.deps.providers = createDefaultRegistry([{ ...DB_PRICE, inputPerMillionTokens: 100, outputPerMillionTokens: 100 }]);
    h.store.prices = [DB_PRICE];
    await send(h);
    expect(h.queue.sent[0]?.estimatedCostUsd).toBe(0.002);
  });

  it('falls back to the static table when the database has no price', async () => {
    const h = await createHarness();
    h.deps.providers = createDefaultRegistry([DB_PRICE]);
    await send(h);
    expect(h.queue.sent[0]).toMatchObject({ usageSource: 'provider_reported', estimatedCostUsd: 0.002 });
  });

  it('caches the price table in Redis, so the database is read once per TTL', async () => {
    const h = await createHarness();
    h.store.prices = [DB_PRICE];
    await send(h, 3);
    expect(h.store.calls.prices).toBe(1);
    expect(h.redis.data.has(PRICING_CACHE_KEY)).toBe(true);
    expect(h.queue.sent.map((e) => e.estimatedCostUsd)).toEqual([0.002, 0.002, 0.002]);
  });

  it('a price-table failure records the request as unpriced instead of losing it', async () => {
    const h = await createHarness();
    h.store.failPrices = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(h);
    expect(h.queue.sent[0]).toMatchObject({ inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0, usageSource: 'unknown' });
  });

  it('does not read prices for a response with no usage to price', async () => {
    const h = await createHarness();
    const res = await handleProxyRequest(proxyRequest(), h.deps); // harness default answer has no usage
    await res.text();
    await h.flush();
    expect(h.queue.sent[0]?.usageSource).toBe('unknown');
    expect(h.store.calls.prices).toBe(0);
  });
});

describe('api_keys.last_used_at (Phase 4, D11)', () => {
  it('writes at most once per throttle window per key', async () => {
    const h = await createHarness();
    await send(h, 3);
    expect(h.store.keyTouches).toHaveLength(1);
    expect(h.store.keyTouches[0]?.apiKeyId).toBe('key-1');
    expect(h.redis.data.has(lastUsedKey('key-1'))).toBe(true);
  });

  it('writes again once the window has expired', async () => {
    const h = await createHarness();
    await send(h);
    h.redis.data.delete(lastUsedKey('key-1')); // what Redis does after LAST_USED_THROTTLE_SECONDS
    await send(h);
    expect(h.store.keyTouches).toHaveLength(2);
  });

  it('only records keys that authenticated', async () => {
    const h = await createHarness();
    const res = await handleProxyRequest(proxyRequest({ headers: { authorization: 'Bearer pk_live_wrong' } }), h.deps);
    expect(res.status).toBe(401);
    await h.flush();
    expect(h.store.keyTouches).toHaveLength(0);
  });

  it('skips the write (not the request) when Redis is down, so a Redis outage never becomes a write per request', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    const store = new FakeStore();
    const telemetry = new FakeTelemetry();
    await recordKeyUse(redis, store, telemetry, 'key-1');
    expect(store.keyTouches).toHaveLength(0);
    expect(telemetry.events).toContainEqual({ metric: 'redis_failures', tags: { operation: 'last_used' }, value: 1 });
  });

  it('never throws when the database write fails', async () => {
    const redis = new FakeRedis();
    const store = new FakeStore();
    store.failing = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordKeyUse(redis, store, new FakeTelemetry(), 'key-1', 0)).resolves.toBeUndefined();
  });

  it('records the time of use as ISO-8601', async () => {
    const store = new FakeStore();
    await recordKeyUse(new FakeRedis(), store, new FakeTelemetry(), 'key-1', Date.UTC(2026, 9, 10, 12));
    expect(store.keyTouches).toEqual([{ apiKeyId: 'key-1', usedAt: '2026-10-10T12:00:00.000Z' }]);
    expect(LAST_USED_THROTTLE_SECONDS).toBe(300);
  });
});
