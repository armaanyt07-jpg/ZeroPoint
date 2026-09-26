import { describe, expect, it } from 'vitest';
import { spendKey } from '../../apps/worker/src/budget';
import { route } from '../../apps/worker/src/router';
import {
  PROVIDER_KEY, PROXY_KEY, TENANT_ID, USER_ID, createHarness, errorCode, proxyRequest,
  type Harness,
} from '../helpers';
import { encryptSecret } from '@zeropoint/crypto';

const send = (h: Harness, req: Request) => route(req, () => h.deps);

describe('happy path', () => {
  it('forwards to OpenAI with the provider key, never the proxy key (FR-1.3)', async () => {
    const h = await createHarness();
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'chatcmpl-1' });

    expect(h.providerFetch).toHaveBeenCalledOnce();
    const upstream = h.providerFetch.mock.calls[0]![0] as Request;
    expect(upstream.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(upstream.headers.get('authorization')).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(upstream.headers.get('x-user-id')).toBeNull();
    expect(upstream.headers.get('x-provider')).toBeNull();
    expect(JSON.stringify([...upstream.headers])).not.toContain(PROXY_KEY);
    expect(await upstream.text()).toBe('{"model":"gpt-4o","messages":[]}');
    expect(h.telemetry.count('requests_allowed')).toBe(1);
  });

  it('accepts a mixed-case x-provider', async () => {
    const h = await createHarness();
    expect((await send(h, proxyRequest({ headers: { 'x-provider': ' OpenAI ' } }))).status).toBe(200);
  });

  it('streams the provider body through without altering it', async () => {
    const h = await createHarness();
    const sse = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    h.providerFetch.mockResolvedValueOnce(
      new Response(new Blob([sse]).stream(), { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'x=1' } }),
    );
    const res = await send(h, proxyRequest());
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe(sse);
  });

  it('allows spend just under the budget', async () => {
    const h = await createHarness();
    h.redis.data.set(spendKey(TENANT_ID, USER_ID), '19.9999');
    expect((await send(h, proxyRequest())).status).toBe(200);
  });
});

describe('authentication (FR-1.1)', () => {
  it.each([
    ['missing Authorization', { authorization: null }],
    ['invalid key', { authorization: 'Bearer pk_live_wrong' }],
    ['missing x-user-id', { 'x-user-id': null }],
  ])('401 UNAUTHORIZED: %s, and the provider is never called', async (_name, headers) => {
    const h = await createHarness();
    const res = await send(h, proxyRequest({ headers }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing credentials.' },
    });
    expect(h.providerFetch).not.toHaveBeenCalled();
  });

  it('401 comes before provider validation so unauthenticated callers learn nothing', async () => {
    const h = await createHarness();
    const res = await send(h, proxyRequest({ headers: { authorization: null, 'x-provider': null } }));
    expect(res.status).toBe(401);
  });

  it('503 (not 401/allow) when the database is unavailable and the key is uncached', async () => {
    const h = await createHarness();
    h.store.failing = true;
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('SERVICE_UNAVAILABLE');
    expect(h.providerFetch).not.toHaveBeenCalled();
  });

  it('a cached key keeps working during a database outage', async () => {
    const h = await createHarness();
    await send(h, proxyRequest()); // warms cache
    h.store.failing = true;
    expect((await send(h, proxyRequest())).status).toBe(200);
  });
});

describe('tenant lookup', () => {
  it('hits Postgres once, then serves the tenant from Redis', async () => {
    const h = await createHarness();
    await send(h, proxyRequest());
    await send(h, proxyRequest());
    expect(h.store.calls.apiKey).toBe(1);
    expect(h.store.calls.credential).toBe(1);
  });

  it('keeps working (via Postgres) when Redis is down: fail-open with telemetry', async () => {
    const h = await createHarness();
    h.redis.failing = true;
    expect((await send(h, proxyRequest())).status).toBe(200);
    expect(h.telemetry.count('redis_failures')).toBeGreaterThan(0);
  });
});

describe('budget guardrail (FR-1.2)', () => {
  it('429 BUDGET_EXCEEDED at the tenant default limit, before contacting the provider', async () => {
    const h = await createHarness();
    h.redis.data.set(spendKey(TENANT_ID, USER_ID), '20');
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { code: 'BUDGET_EXCEEDED', message: 'User spending limit exceeded.' },
    });
    expect(h.providerFetch).not.toHaveBeenCalled();
    expect(h.telemetry.count('budget_rejections')).toBe(1);
  });

  it('uses the per-user limit when present', async () => {
    const h = await createHarness();
    h.store.endUsers.set(`${TENANT_ID}:${USER_ID}`, { id: 'u1', budgetLimitUsd: 5, status: 'active' });
    h.redis.data.set(spendKey(TENANT_ID, USER_ID), '5');
    expect((await send(h, proxyRequest())).status).toBe(429);
  });

  it('a per-user limit higher than the tenant default lets the user through', async () => {
    const h = await createHarness();
    h.store.endUsers.set(`${TENANT_ID}:${USER_ID}`, { id: 'u1', budgetLimitUsd: 100, status: 'active' });
    h.redis.data.set(spendKey(TENANT_ID, USER_ID), '50');
    expect((await send(h, proxyRequest())).status).toBe(200);
  });

  it('missing spend counter = $0 (Phase 1 default: spend stays 0 until settlement in Phase 2)', async () => {
    const h = await createHarness();
    expect((await send(h, proxyRequest())).status).toBe(200);
  });

  it('fails open when Redis is down: request is allowed and telemetry is emitted', async () => {
    const h = await createHarness();
    h.redis.failing = true;
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(200);
    expect(h.telemetry.events.some((e) => e.tags['operation'] === 'spend_read')).toBe(true);
  });

  it("one tenant's spend does not affect another's user of the same name", async () => {
    const h = await createHarness();
    h.redis.data.set(spendKey('other-tenant', USER_ID), '9999');
    expect((await send(h, proxyRequest())).status).toBe(200);
  });
});

describe('blocked users', () => {
  it.each(['blocked', 'suspended'] as const)('403 for %s, provider never called', async (status) => {
    const h = await createHarness();
    h.store.endUsers.set(`${TENANT_ID}:${USER_ID}`, { id: 'u1', budgetLimitUsd: null, status });
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('USER_BLOCKED');
    expect(h.providerFetch).not.toHaveBeenCalled();
  });

  it('an unknown user is treated as active with the tenant default budget', async () => {
    const h = await createHarness();
    expect((await send(h, proxyRequest({ headers: { 'x-user-id': 'never-seen' } }))).status).toBe(200);
  });
});

describe('provider selection (FR-1.4)', () => {
  it('400 MISSING_PROVIDER without x-provider', async () => {
    const h = await createHarness();
    const res = await send(h, proxyRequest({ headers: { 'x-provider': null } }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('MISSING_PROVIDER');
  });

  it.each(['anthropic', 'gemini', 'nonsense'])('400 UNSUPPORTED_PROVIDER for %s', async (provider) => {
    const h = await createHarness();
    const res = await send(h, proxyRequest({ headers: { 'x-provider': provider } }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('UNSUPPORTED_PROVIDER');
    expect(h.providerFetch).not.toHaveBeenCalled();
  });

  it('400 PROVIDER_NOT_CONFIGURED when the tenant has no credential', async () => {
    const h = await createHarness();
    h.store.credentials.clear();
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('500 (generic) when the stored credential cannot be decrypted, without leaking anything', async () => {
    const h = await createHarness();
    // Ciphertext bound to a different tenant must not decrypt for this tenant.
    h.store.credentials.set(
      `${TENANT_ID}:openai`,
      await encryptSecret(PROVIDER_KEY, h.encryptionKey, 'other-tenant:openai'),
    );
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(PROVIDER_KEY);
    expect(h.providerFetch).not.toHaveBeenCalled();
  });
});

describe('provider errors are sanitized (SRS section 8)', () => {
  it('hides provider 401 details (which may echo key fragments) behind a 502', async () => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(
      new Response(`{"error":{"message":"Incorrect API key provided: ${PROVIDER_KEY}"}}`, { status: 401 }),
    );
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('PROVIDER_AUTH_ERROR');
    expect(h.telemetry.count('provider_errors')).toBe(1);
  });

  it('502 for provider 5xx and for network failures', async () => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(new Response('upstream boom', { status: 503 }));
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('boom');

    h.providerFetch.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${PROVIDER_KEY}`));
    const res2 = await send(h, proxyRequest());
    expect(res2.status).toBe(502);
    expect(await errorCode(res2)).toBe('PROVIDER_UNREACHABLE');
  });

  it('passes other 4xx through, with Retry-After, but redacts the credential if echoed', async () => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(
      new Response(`{"error":"rate limited for ${PROVIDER_KEY}"}`, { status: 429, headers: { 'retry-after': '7' } }),
    );
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    const text = await res.text();
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).toContain('[redacted]');
  });
});

describe('router', () => {
  it('GET /health returns ok without auth', async () => {
    const h = await createHarness();
    const res = await send(h, new Request('https://zp.example/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
  it('405 for non-POST on the proxy route, 404 for unknown routes', async () => {
    const h = await createHarness();
    const res = await send(h, proxyRequest({ method: 'GET' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect((await send(h, new Request('https://zp.example/v1/other', { method: 'POST' }))).status).toBe(404);
  });
});

describe('telemetry', () => {
  it('counts requests_total and requests_rejected', async () => {
    const h = await createHarness();
    await send(h, proxyRequest());
    await send(h, proxyRequest({ headers: { authorization: null } }));
    expect(h.telemetry.count('requests_total')).toBe(2);
    expect(h.telemetry.count('requests_rejected')).toBe(1);
  });
});
