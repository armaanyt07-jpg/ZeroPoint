/**
 * End-to-end tests for Phase 3 (docs/PHASE_3_PLAN.md): the circuit breaker as
 * it's actually wired into the request pipeline and the settlement consumer.
 */
import { sha256Hex } from '@zeropoint/crypto';
import { createDefaultRegistry } from '@zeropoint/providers';
import type { ModelPricing } from '@zeropoint/types';
import { describe, expect, it } from 'vitest';
import { circuitKey } from '../../apps/worker/src/circuit-breaker';
import { route } from '../../apps/worker/src/router';
import { handleUsageBatch } from '../../apps/worker/src/settlement';
import {
  DEFAULT_TENANT_POLICY,
  FakeMessage,
  PROXY_KEY,
  TENANT_ID,
  USER_ID,
  createHarness,
  errorCode,
  proxyRequest,
  settlementDeps,
  type Harness,
} from '../helpers';

const send = (h: Harness, req: Request) => route(req, () => h.deps, h.telemetry);

/** Test-only prices (NOT real prices, NOT shipped): $1/million input, $2/million output. */
const PRICES: ModelPricing[] = [{ provider: 'openai', model: 'gpt-4o', inputPerMillionTokens: 1, outputPerMillionTokens: 2 }];

async function priced(): Promise<Harness> {
  const h = await createHarness();
  h.deps.providers = createDefaultRegistry(PRICES);
  return h;
}

const jsonUsage = (input: number, output: number) =>
  new Response(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: input, completion_tokens: output } }), {
    headers: { 'content-type': 'application/json' },
  });

describe('FR-3.5: an already-open circuit blocks before budget or the provider', () => {
  it('429 CIRCUIT_OPEN with Retry-After, and the provider is never called', async () => {
    const h = await createHarness();
    h.redis.data.set(circuitKey(TENANT_ID, USER_ID), `loop:${Date.now() + 42_000}`);
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('CIRCUIT_OPEN');
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(42);
    expect(h.providerFetch).not.toHaveBeenCalled();
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 0, rejected: 1 });
  });

  it('a Redis failure while reading circuit state fails open (NFR-5.3): the request proceeds', async () => {
    const h = await createHarness();
    h.redis.failing = true;
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(200);
    expect(h.telemetry.events.some((e) => e.tags['operation'] === 'circuit_read')).toBe(true);
  });
});

describe('FR-3.3: three consecutive matching request hashes trip the loop breaker', () => {
  it('the first two identical requests succeed; the third is blocked, not forwarded', async () => {
    const h = await createHarness();
    const body = '{"model":"gpt-4o","messages":[{"role":"user","content":"same every time"}]}';
    expect((await send(h, proxyRequest({ body }))).status).toBe(200);
    expect((await send(h, proxyRequest({ body }))).status).toBe(200);
    expect(h.providerFetch).toHaveBeenCalledTimes(2);

    const res = await send(h, proxyRequest({ body }));
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('CIRCUIT_OPEN');
    expect(h.providerFetch).toHaveBeenCalledTimes(2); // never reached the provider

    await h.flush(); // recordAndNotify is deferred (deps.defer)
    expect(h.store.circuitBreakerEvents).toEqual([
      { tenantId: TENANT_ID, externalUserId: USER_ID, reason: 'loop', openedAt: expect.any(String), expiresAt: expect.any(String) },
    ]);
    expect(h.telemetry.count('circuit_breaker_events')).toBe(1);
  });

  it('a fourth identical request while already open still 429s (circuit stays open)', async () => {
    const h = await createHarness();
    const body = '{"model":"gpt-4o","messages":[{"role":"user","content":"loop"}]}';
    for (let i = 0; i < 3; i++) await send(h, proxyRequest({ body }));
    const res = await send(h, proxyRequest({ body }));
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('CIRCUIT_OPEN');
  });

  it('varying bodies never trip the breaker', async () => {
    const h = await createHarness();
    for (let i = 0; i < 6; i++) {
      const res = await send(h, proxyRequest({ body: `{"model":"gpt-4o","messages":[],"n":${i}}` }));
      expect(res.status).toBe(200);
    }
  });

  it('a body over the hashing cap is exempt (D1): never trips even when repeated', async () => {
    const h = await createHarness();
    const body = `{"model":"gpt-4o","messages":[{"content":"${'x'.repeat(1024 * 1024 + 1)}"}]}`;
    for (let i = 0; i < 4; i++) {
      expect((await send(h, proxyRequest({ body }))).status).toBe(200);
    }
  });

  it('dispatches a webhook when the tenant has webhook_url configured', async () => {
    const h = await createHarness();
    h.store.apiKeys.get(await sha256Hex(PROXY_KEY))!.policy = {
      ...DEFAULT_TENANT_POLICY,
      webhookUrl: 'https://tenant.example/hook',
    };
    const body = '{"model":"gpt-4o","messages":[{"role":"user","content":"loop"}]}';
    for (let i = 0; i < 3; i++) await send(h, proxyRequest({ body }));
    await h.flush();
    expect(h.webhookQueue.sent).toEqual([
      {
        tenantId: TENANT_ID,
        externalUserId: USER_ID,
        webhookUrl: 'https://tenant.example/hook',
        reason: 'loop',
        openedAt: expect.any(String),
        expiresAt: expect.any(String),
      },
    ]);
  });
});

describe('FR-3.1/3.2: velocity, tracked through real settlement, opens the circuit for the NEXT request', () => {
  it('a low per-tenant threshold trips after the second settled request', async () => {
    const h = await priced();
    // Settlement (settlementDeps) reads tenant policy through h.usageStore, not h.store.
    h.usageStore.policies.set(TENANT_ID, { ...DEFAULT_TENANT_POLICY, velocityLimitUsd: 0.003 });
    h.providerFetch.mockImplementation(async () => jsonUsage(1000, 500)); // fresh Response each call; $0.002 each (PRICES above)

    expect((await send(h, proxyRequest({ body: '{"model":"gpt-4o","messages":[],"n":1}' }))).status).toBe(200);
    await h.flush();
    await handleUsageBatch([new FakeMessage(h.queue.sent[0]!)], settlementDeps(h));
    expect(h.redis.data.has(circuitKey(TENANT_ID, USER_ID))).toBe(false); // $0.002 alone: under $0.003

    expect((await send(h, proxyRequest({ body: '{"model":"gpt-4o","messages":[],"n":2}' }))).status).toBe(200);
    await h.flush();
    await handleUsageBatch([new FakeMessage(h.queue.sent[1]!)], settlementDeps(h));
    expect(h.redis.data.get(circuitKey(TENANT_ID, USER_ID))).toMatch(/^velocity:\d+$/); // $0.004 total: over

    const res = await send(h, proxyRequest({ body: '{"model":"gpt-4o","messages":[],"n":3}' }));
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('CIRCUIT_OPEN');
    // Settlement (settlementDeps) records through h.usageStore, not h.store.
    expect(h.usageStore.circuitBreakerEvents).toEqual([
      { tenantId: TENANT_ID, externalUserId: USER_ID, reason: 'velocity', openedAt: expect.any(String), expiresAt: expect.any(String) },
    ]);
  });
});

describe('CIRCUIT_OPEN never leaks anything about the request that tripped it', () => {
  it('the error body is the generic SRS 6.4 shape', async () => {
    const h = await createHarness();
    h.redis.data.set(circuitKey(TENANT_ID, USER_ID), `loop:${Date.now() + 900_000}`);
    const body = (await (await send(h, proxyRequest())).json()) as { error: { code: string; message: string } };
    expect(body).toEqual({ error: { code: 'CIRCUIT_OPEN', message: 'AI request temporarily blocked by ZeroPoint protection.' } });
  });
});

