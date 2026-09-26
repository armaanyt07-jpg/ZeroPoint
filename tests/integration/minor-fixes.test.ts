/** Regression tests for the MINOR findings in docs/PHASE_1_REVIEW.md. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../apps/worker/src/index';
import { ZeroPointError } from '../../apps/worker/src/errors';
import { route } from '../../apps/worker/src/router';
import { ConsoleTelemetry } from '../../apps/worker/src/telemetry';
import { createHarness, proxyRequest, PROVIDER_KEY, type Harness } from '../helpers';

const send = (h: Harness, req: Request, requestId?: string) => route(req, () => h.deps, h.telemetry, requestId);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.restoreAllMocks());

describe('Minor 1: /health', () => {
  const health = (method = 'GET') => new Request('https://zp.example/health', { method });

  it('200 {status:"ok"} for GET when configured, with no-store caching', async () => {
    const h = await createHarness();
    const res = await send(h, health());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('HEAD is allowed and has no body', async () => {
    const h = await createHarness();
    const res = await send(h, health('HEAD'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('405 for %s', async (method) => {
    const h = await createHarness();
    const res = await send(h, new Request('https://zp.example/health', { method, body: method === 'DELETE' ? null : '{}' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('503 {status:"unavailable"} when required configuration is missing, without naming what', async () => {
    const h = await createHarness();
    const res = await route(
      health(),
      () => { throw new ZeroPointError(500, 'CONFIGURATION_ERROR', 'The service is not configured correctly.'); },
      h.telemetry,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable' });
  });

  it('through the real entrypoint: 503 with empty env, 200 with all secrets present', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const bare = await worker.fetch(health(), {} as never, ctx);
    expect(bare.status).toBe(503);
    expect(await bare.text()).not.toMatch(/UPSTASH|SUPABASE|CREDENTIAL/);

    const env = {
      UPSTASH_REDIS_REST_URL: 'https://r.test', UPSTASH_REDIS_REST_TOKEN: 't',
      SUPABASE_URL: 'https://d.test', SUPABASE_SERVICE_ROLE_KEY: 's', CREDENTIAL_ENCRYPTION_KEY: 'k',
    };
    expect((await worker.fetch(health(), env, ctx)).status).toBe(200);
  });

  it('makes no Redis or database calls and is not counted as proxy traffic', async () => {
    const h = await createHarness();
    await send(h, health());
    expect(h.redis.getCalls).toHaveLength(0);
    expect(h.store.calls).toEqual({ apiKey: 0, endUser: 0, credential: 0 });
    expect(h.telemetry.accounting()).toEqual({ total: 0, allowed: 0, rejected: 0 });
  });
});

describe('Minor 2: request_id', () => {
  it('every proxy response carries a unique UUID x-request-id: 200, 4xx, 5xx, 404 and 405', async () => {
    const h = await createHarness();
    const responses = [await send(h, proxyRequest())]; // 200
    responses.push(await send(h, proxyRequest({ headers: { authorization: null } }))); // 401
    h.providerFetch.mockResolvedValueOnce(new Response('x', { status: 500 }));
    responses.push(await send(h, proxyRequest())); // 502 (provider 500)
    responses.push(await send(h, proxyRequest({ path: '/nope' }))); // 404
    responses.push(await send(h, proxyRequest({ method: 'GET' }))); // 405
    const ids = responses.map((r) => r.headers.get('x-request-id'));
    expect(responses.map((r) => r.status)).toEqual([200, 401, 502, 404, 405]);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the id it was given, and ignores a client-supplied x-request-id', async () => {
    const h = await createHarness();
    const res = await send(h, proxyRequest({ headers: { 'x-request-id': 'attacker {"type":"fake-log-line"}' } }), 'fixed-id-123');
    expect(res.headers.get('x-request-id')).toBe('fixed-id-123');
  });

  it('does not forward any x-request-id upstream', async () => {
    const h = await createHarness();
    await send(h, proxyRequest({ headers: { 'x-request-id': 'client-id' } }));
    expect((h.providerFetch.mock.calls[0]![0] as Request).headers.get('x-request-id')).toBeNull();
  });

  it('still streams: the body is passed through untouched', async () => {
    const h = await createHarness();
    const sse = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    h.providerFetch.mockResolvedValueOnce(new Response(new Blob([sse]).stream(), { headers: { 'content-type': 'text/event-stream' } }));
    const res = await send(h, proxyRequest());
    expect(res.headers.get('x-request-id')).toMatch(UUID);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe(sse);
  });

  it('ConsoleTelemetry stamps its base tags on every metric', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    new ConsoleTelemetry({ request_id: 'abc' }).increment('requests_total');
    new ConsoleTelemetry({ request_id: 'abc' }).increment('requests_rejected', { code: 'X' });
    new ConsoleTelemetry().increment('requests_total');
    const lines = log.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(lines[0]).toMatchObject({ metric: 'requests_total', request_id: 'abc' });
    expect(lines[1]).toMatchObject({ metric: 'requests_rejected', code: 'X', request_id: 'abc' });
    expect(lines[2]).not.toHaveProperty('request_id');
  });

  describe('through the real entrypoint', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('the response header matches the request_id on every log line, and never a client value', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubGlobal('fetch', async () => new Response('down', { status: 500 })); // Redis/DB unavailable
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://r.test', UPSTASH_REDIS_REST_TOKEN: 't',
        SUPABASE_URL: 'https://d.test', SUPABASE_SERVICE_ROLE_KEY: 's', CREDENTIAL_ENCRYPTION_KEY: 'k',
      };
      const res = await worker.fetch(
        proxyRequest({ headers: { 'x-request-id': 'client-chosen' } }),
        env,
        { waitUntil() {} } as unknown as ExecutionContext,
      );
      const id = res.headers.get('x-request-id')!;
      expect(res.status).toBe(503);
      expect(id).toMatch(UUID);
      expect(id).not.toBe('client-chosen');
      const lines = log.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, string>);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line['request_id']).toBe(id);
    });

    it('error logs (store_error) also carry the request_id', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const h = await createHarness();
      h.store.failing = true;
      await send(h, proxyRequest(), 'req-42');
      const logged = err.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, string>);
      expect(logged.find((l) => l['type'] === 'store_error')?.['request_id']).toBe('req-42');
    });
  });

  it('the request_id never contains, and is not derived from, credentials', async () => {
    const h = await createHarness();
    const res = await send(h, proxyRequest());
    expect(res.headers.get('x-request-id')).not.toContain(PROVIDER_KEY);
  });
});
