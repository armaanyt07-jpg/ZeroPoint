/**
 * Regression tests for docs/PHASE_1_REVIEW.md (Critical 1-3, Major 1-5).
 * Critical 4 is covered in tests/unit/clients.test.ts.
 */
import { encryptSecret, generateEncryptionKey, sha256Hex } from '@zeropoint/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../apps/worker/src/index';
import { route } from '../../apps/worker/src/router';
import { redactSecrets } from '../../apps/worker/src/proxy';
import {
  PROVIDER_KEY, PROXY_KEY, TENANT_ID, USER_ID, addCredential, createHarness, errorCode,
  proxyRequest, type Harness,
} from '../helpers';

const send = (h: Harness, req: Request) => route(req, () => h.deps, h.telemetry);

describe('Critical 1: request accounting', () => {
  it('a successful request is counted as allowed, not rejected', async () => {
    const h = await createHarness();
    await send(h, proxyRequest());
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 1, rejected: 0 });
  });

  it.each([
    ['provider 5xx', () => new Response('boom', { status: 503 })],
    ['provider 401', () => new Response('{}', { status: 401 })],
    ['provider 404', () => new Response('{}', { status: 404 })],
    ['provider 429', () => new Response('{}', { status: 429 })],
  ])('%s is counted as rejected only, never also as allowed', async (_n, make) => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(make());
    await send(h, proxyRequest());
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 0, rejected: 1 });
  });

  it('a network failure to the provider is rejected only', async () => {
    const h = await createHarness();
    h.providerFetch.mockRejectedValueOnce(new Error('dns'));
    await send(h, proxyRequest());
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 0, rejected: 1 });
  });

  it('holds total = allowed + rejected over a mixed batch', async () => {
    const h = await createHarness();
    await send(h, proxyRequest()); // allowed
    await send(h, proxyRequest({ headers: { authorization: null } })); // 401
    await send(h, proxyRequest({ headers: { 'x-provider': 'cohere' } })); // 400
    h.providerFetch.mockResolvedValueOnce(new Response('x', { status: 500 }));
    await send(h, proxyRequest()); // 502
    const a = h.telemetry.accounting();
    expect(a.total).toBe(4);
    expect(a.allowed + a.rejected).toBe(a.total);
  });
});

describe('Critical 2: upstream response headers', () => {
  it('drops provider-identifying headers and keeps only content-type / cache-control', async () => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(
      new Response('{"ok":true}', {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'openai-organization': 'org-SECRET',
          'openai-project': 'proj_SECRET',
          'openai-version': '2020-10-01',
          'x-request-id': 'req_abc',
          'openai-processing-ms': '120',
          server: 'cloudflare',
          'cf-ray': 'abc-LHR',
          'set-cookie': 'a=b',
          'x-ratelimit-remaining-tokens': '999',
        },
      }),
    );
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(200);
    // content-type / cache-control from the provider, plus ZeroPoint's own x-request-id.
    expect([...res.headers.keys()].sort()).toEqual(['cache-control', 'content-type', 'x-request-id']);
    expect(res.headers.get('x-request-id')).not.toBe('req_abc'); // ours, not the provider's
    expect(JSON.stringify([...res.headers])).not.toContain('SECRET');
  });
});

describe('Major 1: Anthropic and Gemini routing (FR-1.4)', () => {
  it('routes /v1/messages to Anthropic with the tenant key in x-api-key', async () => {
    const h = await createHarness();
    await addCredential(h, 'anthropic', 'sk-ant-TENANT');
    const res = await send(
      h,
      proxyRequest({ path: '/v1/messages', headers: { 'x-provider': 'anthropic' } }),
    );
    expect(res.status).toBe(200);
    const upstream = h.providerFetch.mock.calls[0]![0] as Request;
    expect(upstream.url).toBe('https://api.anthropic.com/v1/messages');
    expect(upstream.headers.get('x-api-key')).toBe('sk-ant-TENANT');
    expect(upstream.headers.get('authorization')).toBeNull();
    expect(JSON.stringify([...upstream.headers])).not.toContain(PROXY_KEY);
  });

  it('routes Gemini model paths, including streaming with alt=sse', async () => {
    const h = await createHarness();
    await addCredential(h, 'gemini', 'AIza-TENANT');
    const path = '/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse';
    const res = await send(h, proxyRequest({ path, headers: { 'x-provider': 'gemini' } }));
    expect(res.status).toBe(200);
    const upstream = h.providerFetch.mock.calls[0]![0] as Request;
    expect(upstream.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
    );
    expect(upstream.headers.get('x-goog-api-key')).toBe('AIza-TENANT');
  });

  it('a tenant credential for one provider is never used for another', async () => {
    const h = await createHarness(); // only has an openai key
    const res = await send(h, proxyRequest({ path: '/v1/messages', headers: { 'x-provider': 'anthropic' } }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('PROVIDER_NOT_CONFIGURED');
    expect(h.providerFetch).not.toHaveBeenCalled();
  });

  it('400 when x-provider does not match the requested path', async () => {
    const h = await createHarness();
    await addCredential(h, 'anthropic', 'sk-ant-TENANT');
    const res = await send(h, proxyRequest({ path: '/v1/messages', headers: { 'x-provider': 'openai' } }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('UNSUPPORTED_PROVIDER');
    expect(h.providerFetch).not.toHaveBeenCalled();
  });

  it('new paths get the same guardrails (401, 429, 403) before any provider call', async () => {
    const h = await createHarness();
    await addCredential(h, 'anthropic', 'sk-ant-TENANT');
    const opts = { path: '/v1/messages', headers: { 'x-provider': 'anthropic' } };
    expect((await send(h, proxyRequest({ ...opts, headers: { ...opts.headers, authorization: null } }))).status).toBe(401);
    h.redis.data.set(`spend:${TENANT_ID}:${USER_ID}`, '20');
    expect((await send(h, proxyRequest(opts))).status).toBe(429);
    h.store.endUsers.set(`${TENANT_ID}:${USER_ID}`, { id: 'u', budgetLimitUsd: null, status: 'blocked' });
    h.redis.data.clear();
    expect((await send(h, proxyRequest(opts))).status).toBe(403);
    expect(h.providerFetch).not.toHaveBeenCalled();
  });

  it('unknown paths are still 404 and non-POST on provider paths is 405', async () => {
    const h = await createHarness();
    expect((await send(h, proxyRequest({ path: '/v1/embeddings' }))).status).toBe(404);
    expect((await send(h, proxyRequest({ path: '/v1/messages', method: 'GET' }))).status).toBe(405);
    expect((await send(h, proxyRequest({ path: '/v1beta/models/g:generateContent', method: 'GET' }))).status).toBe(405);
  });
});

describe('Major 2: pre-flight latency structure (NFR-5.1)', () => {
  it('once the tenant is known, user, spend and credential lookups run concurrently', async () => {
    const h = await createHarness();
    await send(h, proxyRequest()); // warm the caches
    await h.flush();
    h.redis.getDelayMs = 5;
    h.redis.maxInFlight = 0;
    h.redis.getCalls = [];
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(200);
    expect(h.redis.maxInFlight).toBeGreaterThanOrEqual(3);
  });

  it('uses two sequential Redis stages on a warm request (api key, then the parallel three)', async () => {
    const h = await createHarness();
    await send(h, proxyRequest());
    await h.flush();
    h.redis.getCalls = [];
    await send(h, proxyRequest());
    expect(h.redis.getCalls).toHaveLength(5); // apikey, enduser, spend, circuit state, credential
    expect(h.redis.getCalls[0]).toMatch(/^cache:apikey:/);
  });

  describe('policy decisions take precedence over a failing credential lookup', () => {
    it('blocked user -> 403, not 503', async () => {
      const h = await createHarness();
      h.store.failCredentials = true;
      h.store.endUsers.set(`${TENANT_ID}:${USER_ID}`, { id: 'u', budgetLimitUsd: null, status: 'blocked' });
      const res = await send(h, proxyRequest());
      expect(res.status).toBe(403);
      expect(h.providerFetch).not.toHaveBeenCalled();
    });
    it('over-budget user -> 429, not 503', async () => {
      const h = await createHarness();
      h.store.failCredentials = true;
      h.redis.data.set(`spend:${TENANT_ID}:${USER_ID}`, '20');
      expect((await send(h, proxyRequest())).status).toBe(429);
    });
    it('an allowed user with a failing credential lookup -> 503 (cannot forward), counted as rejected', async () => {
      const h = await createHarness();
      h.store.failCredentials = true;
      const res = await send(h, proxyRequest());
      expect(res.status).toBe(503);
      expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 0, rejected: 1 });
    });
  });

  it('does not decrypt or call the provider for a blocked or over-budget user', async () => {
    const h = await createHarness();
    h.store.endUsers.set(`${TENANT_ID}:${USER_ID}`, { id: 'u', budgetLimitUsd: null, status: 'blocked' });
    expect((await send(h, proxyRequest())).status).toBe(403);
    expect(h.providerFetch).not.toHaveBeenCalled();
  });
});

describe('Major 3: ExecutionContext and non-blocking cache writes', () => {
  it('a slow Redis SET does not delay the response; the write is handed to background work', async () => {
    const h = await createHarness();
    h.redis.hangOnSet = true; // SET never completes
    const res = await send(h, proxyRequest()); // would hang forever if SET were awaited
    expect(res.status).toBe(200);
    expect(h.deferred.length).toBeGreaterThan(0);
  });

  it('a failed background cache write is reported via telemetry, not thrown', async () => {
    const h = await createHarness();
    h.redis.failing = true;
    expect((await send(h, proxyRequest())).status).toBe(200);
    await h.flush();
    expect(h.telemetry.events.some((e) => e.tags['operation'] === 'cache_write')).toBe(true);
  });

  describe('Worker entrypoint passes ctx.waitUntil through', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('registers cache writes with ctx.waitUntil and serves the request', async () => {
      const encryptionKey = generateEncryptionKey();
      const keyHash = await sha256Hex(PROXY_KEY);
      const credential = await encryptSecret(PROVIDER_KEY, encryptionKey, `${TENANT_ID}:openai`);
      const seen: string[] = [];

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.origin}${url.pathname}`);
        if (url.origin === 'https://redis.test') {
          const [cmd] = JSON.parse(await req.text()) as string[];
          return Response.json({ result: cmd === 'SET' ? 'OK' : null });
        }
        if (url.origin === 'https://db.test') {
          const rows: Record<string, unknown[]> = {
            '/rest/v1/api_keys': [
              {
                id: 'k1',
                tenant_id: TENANT_ID,
                status: 'active',
                tenants: {
                  default_budget_usd: 20,
                  velocity_limit_usd: 2,
                  velocity_window_seconds: 60,
                  circuit_breaker_duration_seconds: 900,
                  webhook_url: null,
                },
              },
            ],
            '/rest/v1/end_users': [],
            '/rest/v1/tenant_provider_credentials': [{ encrypted_api_key: credential }],
          };
          expect(url.searchParams.get('key_hash') ?? keyHash).toBeTruthy();
          return Response.json(rows[url.pathname] ?? []);
        }
        if (url.origin === 'https://api.openai.com') {
          expect(req.headers.get('authorization')).toBe(`Bearer ${PROVIDER_KEY}`);
          return new Response('{"id":"x"}', { headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected fetch ${req.url}`);
      });

      const waitUntil = vi.fn();
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.test',
        UPSTASH_REDIS_REST_TOKEN: 't',
        SUPABASE_URL: 'https://db.test',
        SUPABASE_SERVICE_ROLE_KEY: 's',
        CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
        USAGE_QUEUE: { send: async () => {} } as never,
      WEBHOOK_QUEUE: { send: async () => {} } as never,
      };
      const res = await worker.fetch(proxyRequest(), env, { waitUntil } as unknown as ExecutionContext);
      expect(res.status).toBe(200);
      expect(waitUntil).toHaveBeenCalled(); // cache writes were deferred
      await Promise.all(waitUntil.mock.calls.map((c) => c[0] as Promise<unknown>));
      expect(seen.filter((s) => s.startsWith('POST https://redis.test')).length).toBeGreaterThan(3);
    });

    it('returns a safe 500 and counts the request when configuration is missing', async () => {
      const res = await worker.fetch(proxyRequest(), {} as never, { waitUntil() {} } as unknown as ExecutionContext);
      expect(res.status).toBe(500);
      expect(await errorCode(res)).toBe('CONFIGURATION_ERROR');
    });
  });
});

describe('Major 4: every rejection is counted', () => {
  it('503 (database down) counts requests_rejected', async () => {
    const h = await createHarness();
    h.store.failing = true;
    expect((await send(h, proxyRequest())).status).toBe(503);
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 0, rejected: 1 });
  });

  it('500 (undecryptable credential) counts requests_rejected', async () => {
    const h = await createHarness();
    h.store.credentials.set(`${TENANT_ID}:openai`, 'v1:AAAA:BBBB');
    expect((await send(h, proxyRequest())).status).toBe(500);
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 0, rejected: 1 });
  });

  it('an unexpected exception (500 INTERNAL_ERROR) counts requests_rejected', async () => {
    const h = await createHarness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(h.deps.directory, 'getApiKey').mockRejectedValueOnce(new TypeError('bug'));
    expect((await send(h, proxyRequest())).status).toBe(500);
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 0, rejected: 1 });
    vi.restoreAllMocks();
  });

  it('404 and 405 are counted in both requests_total and requests_rejected', async () => {
    const h = await createHarness();
    expect((await send(h, proxyRequest({ path: '/nope' }))).status).toBe(404);
    expect((await send(h, proxyRequest({ method: 'GET' }))).status).toBe(405);
    expect(h.telemetry.accounting()).toEqual({ total: 2, allowed: 0, rejected: 2 });
    expect(h.telemetry.events.filter((e) => e.metric === 'requests_rejected').map((e) => e.tags['code'])).toEqual([
      'NOT_FOUND',
      'METHOD_NOT_ALLOWED',
    ]);
  });

  it('a configuration error before the pipeline is counted too', async () => {
    const h = await createHarness();
    const { ZeroPointError } = await import('../../apps/worker/src/errors');
    const res = await route(
      proxyRequest(),
      () => { throw new ZeroPointError(500, 'CONFIGURATION_ERROR', 'x'); },
      h.telemetry,
    );
    expect(res.status).toBe(500);
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 0, rejected: 1 });
  });

  it('/health is not counted as proxy traffic', async () => {
    const h = await createHarness();
    await send(h, new Request('https://zp.example/health'));
    expect(h.telemetry.accounting()).toEqual({ total: 0, allowed: 0, rejected: 0 });
  });
});

describe('Major 5: provider 4xx errors use the SRS error schema', () => {
  const errorBody = async (res: Response) => (await res.json()) as { error: Record<string, unknown> };

  it.each([
    [400, 'PROVIDER_REQUEST_REJECTED', 'Invalid request: messages must not be empty.'],
    [404, 'PROVIDER_REQUEST_REJECTED', 'The model gpt-9 does not exist.'],
    [422, 'PROVIDER_REQUEST_REJECTED', 'Unprocessable.'],
  ])('%i becomes {error:{code,message}} with the provider message', async (status, code, message) => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message, type: 'invalid_request_error', code: 'model_not_found', param: 'model' } }), { status }),
    );
    const res = await send(h, proxyRequest());
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await errorBody(res)).toEqual({ error: { code, message } });
  });

  it('uses a generic message when the body is not JSON or has no message', async () => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(new Response('<html>Bad Request</html>', { status: 400 }));
    expect(await errorBody(await send(h, proxyRequest()))).toEqual({
      error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'The provider rejected the request.' },
    });
    h.providerFetch.mockResolvedValueOnce(new Response('{"error":{"message":42}}', { status: 429 }));
    expect(await errorBody(await send(h, proxyRequest()))).toEqual({
      error: { code: 'PROVIDER_RATE_LIMITED', message: 'The provider rate limit was reached.' },
    });
  });

  it('keeps a numeric Retry-After only', async () => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '12' } }));
    expect((await send(h, proxyRequest())).headers.get('retry-after')).toBe('12');
    h.providerFetch.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026' } }));
    expect((await send(h, proxyRequest())).headers.get('retry-after')).toBeNull();
  });

  it('truncates very long provider messages', async () => {
    const h = await createHarness();
    h.providerFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'x'.repeat(5000) } }), { status: 400 }),
    );
    const { error } = await errorBody(await send(h, proxyRequest()));
    expect((error['message'] as string).length).toBeLessThanOrEqual(300);
  });

  it('does not leak the key even when the provider echoes it masked or URL-encoded', async () => {
    const h = await createHarness();
    // Each iteration sends a distinct body (Phase 3's `n` marker) so the loop
    // breaker (FR-3.3) never sees four identical requests from the same user.
    for (const [n, echoed] of [
      `Bad key ${PROVIDER_KEY}`,
      'Incorrect key: sk-proj-****abcd',
      'key sk-ant-api03-abcdefgh1234 invalid',
      'key AIzaSyA1234567890abcdefg invalid',
    ].entries()) {
      h.providerFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: echoed } }), { status: 400 }));
      const text = await (await send(h, proxyRequest({ body: `{"model":"gpt-4o","messages":[],"n":${n}}` }))).text();
      expect(text).not.toMatch(/sk-proj|sk-ant|AIza|sk-provider-secret/);
      expect(text).toContain('[redacted]');
    }
  });

  it('still hides provider 401/403 and 5xx behind 502s', async () => {
    const h = await createHarness();
    // Same reasoning as above: a distinct body per iteration avoids tripping FR-3.3.
    for (const [n, [status, code]] of ([[401, 'PROVIDER_AUTH_ERROR'], [403, 'PROVIDER_AUTH_ERROR'], [500, 'PROVIDER_ERROR'], [503, 'PROVIDER_ERROR']] as const).entries()) {
      h.providerFetch.mockResolvedValueOnce(new Response(`{"error":{"message":"${PROVIDER_KEY}"}}`, { status }));
      const res = await send(h, proxyRequest({ body: `{"model":"gpt-4o","messages":[],"n":${n}}` }));
      expect(res.status).toBe(502);
      expect(await errorCode(res)).toBe(code);
    }
  });

  it('redactSecrets handles the exact key and key-shaped strings', () => {
    expect(redactSecrets('a KEY123 b', 'KEY123')).toBe('a [redacted] b');
    expect(redactSecrets('sk-abcd1234 and AIzaSyABCDEFGHIJKL', 'nope')).toBe('[redacted] and [redacted]');
    expect(redactSecrets('nothing secret here', 'nope')).toBe('nothing secret here');
  });
});
