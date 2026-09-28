import { describe, expect, it, vi } from 'vitest';
import { RedisError, UpstashRedis } from '../../apps/worker/src/redis';
import { StoreError, SupabaseStore } from '../../apps/worker/src/store';
import type { UsageEvent } from '@zeropoint/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('UpstashRedis', () => {
  it('sends GET as a JSON command with the bearer token', async () => {
    const f = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => json({ result: '4.2' }));
    const redis = new UpstashRedis('https://r.example', 'tok', f as unknown as typeof fetch);
    expect(await redis.get('spend:t:u')).toBe('4.2');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://r.example');
    expect(JSON.parse(init!.body as string)).toEqual(['GET', 'spend:t:u']);
    expect((init!.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });
  it('returns null for a missing key and sends SET ... EX', async () => {
    const f = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => json({ result: null }));
    const redis = new UpstashRedis('https://r.example', 't', f as unknown as typeof fetch);
    expect(await redis.get('k')).toBeNull();
    await redis.set('k', 'v', 60);
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual(['SET', 'k', 'v', 'EX', 60]);
  });
  it('throws RedisError on HTTP errors, command errors and network failures', async () => {
    const mk = (f: () => Promise<Response>) => new UpstashRedis('https://r', 't', f as unknown as typeof fetch);
    await expect(mk(async () => json({}, 500)).get('k')).rejects.toThrow(RedisError);
    await expect(mk(async () => json({ error: 'ERR' })).get('k')).rejects.toThrow(RedisError);
    await expect(mk(async () => { throw new Error('boom'); }).get('k')).rejects.toThrow(RedisError);
  });
});

describe('SupabaseStore', () => {
  const store = (f: (url: string, init: RequestInit) => Promise<Response>) =>
    new SupabaseStore('https://p.supabase.co', 'svc', f as unknown as typeof fetch);

  it('looks up an api key by hash, embedding the tenant budget', async () => {
    let seen = '';
    const s = store(async (url, init) => {
      seen = url;
      expect((init.headers as Record<string, string>)['apikey']).toBe('svc');
      return json([{ id: 'k1', tenant_id: 't1', status: 'active', tenants: { default_budget_usd: '20.0000' } }]);
    });
    expect(await s.findApiKeyByHash('abc')).toEqual({
      apiKeyId: 'k1', tenantId: 't1', status: 'active', defaultBudgetUsd: 20,
    });
    expect(seen).toContain('/rest/v1/api_keys?');
    expect(seen).toContain('key_hash=eq.abc');
  });

  it('returns null when no row matches', async () => {
    expect(await store(async () => json([])).findApiKeyByHash('x')).toBeNull();
    expect(await store(async () => json([])).findEndUser('t', 'u')).toBeNull();
    expect(await store(async () => json([])).findProviderCredential('t', 'openai')).toBeNull();
  });

  it('maps end users, including a null budget override', async () => {
    const s = store(async () => json([{ id: 'u1', budget_limit_usd: null, status: 'blocked' }]));
    expect(await s.findEndUser('t', 'ext')).toEqual({ id: 'u1', budgetLimitUsd: null, status: 'blocked' });
  });

  it('URL-encodes user input so it cannot inject extra filters', async () => {
    let seen = '';
    const s = store(async (url) => { seen = url; return json([]); });
    await s.findEndUser('t', 'x&status=eq.active');
    const params = new URL(seen).searchParams;
    expect(params.get('external_user_id')).toBe('eq.x&status=eq.active');
    expect(params.get('status')).toBeNull();
  });

  it('throws StoreError on HTTP errors, bad shapes and network failures', async () => {
    await expect(store(async () => json({}, 500)).findEndUser('t', 'u')).rejects.toThrow(StoreError);
    await expect(store(async () => json({ not: 'array' })).findEndUser('t', 'u')).rejects.toThrow(StoreError);
    await expect(store(async () => json([{ id: 'u', budget_limit_usd: 1, status: 'weird' }])).findEndUser('t', 'u')).rejects.toThrow(StoreError);
    await expect(store(async () => { throw new Error('x'); }).findEndUser('t', 'u')).rejects.toThrow(StoreError);
  });

  /**
   * Review Critical 4 proposed wrapping the value as eq."<value>". That is wrong for
   * plain filters: PostgREST parses an `eq.` value with `pSingleVal = many anyChar`
   * (src/library/PostgREST/ApiRequest/QueryParams.hs), i.e. RAW text. Quotes are only
   * interpreted inside in.(...) and or=(...). Adding them would make every lookup
   * compare against the literal string "\"user\"", so no user would ever match and
   * blocking/per-user budgets would silently stop working. These tests pin the correct
   * behaviour: values are sent unquoted, percent-encoded, and `eq.null` is a plain
   * string comparison (SQL NULL needs `is.null`).
   */
  describe('end-user filter values (PostgREST raw eq. semantics)', () => {
    const sent = async (externalUserId: string) => {
      let seen = '';
      const s = store(async (url) => { seen = url; return json([]); });
      await s.findEndUser('t', externalUserId);
      return new URL(seen).searchParams.get('external_user_id');
    };

    it.each(['null', 'a,b', 'a.b', 'jane@example.com', 'O\'Brien', 'say "hi"', 'a b', 'x(y)', '100%'])(
      'sends %j as eq.<value> with no added quoting',
      async (id) => {
        expect(await sent(id)).toBe(`eq.${id}`);
      },
    );

    it('never wraps the value in double quotes', async () => {
      expect(await sent('user_123')).not.toContain('"');
    });

    it('round-trips awkward ids through URL encoding', async () => {
      let raw = '';
      const s = store(async (url) => { raw = url; return json([]); });
      await s.findEndUser('t', 'a,b"c&d=e');
      expect(raw).not.toContain('a,b"c&d=e'); // encoded on the wire
      expect(new URL(raw).searchParams.get('external_user_id')).toBe('eq.a,b"c&d=e');
    });
  });
});

describe('UpstashRedis.eval (Phase 2)', () => {
  it('sends EVAL <script> <numkeys> <keys...> <args...> and returns the script result', async () => {
    const f = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => json({ result: 1 }));
    const redis = new UpstashRedis('https://r.example', 't', f as unknown as typeof fetch);
    expect(await redis.eval('return 1', ['k1', 'k2'], ['a', 5])).toBe(1);
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual(['EVAL', 'return 1', 2, 'k1', 'k2', 'a', 5]);
  });
  it('throws RedisError when the script errors', async () => {
    const redis = new UpstashRedis('https://r', 't', (async () => json({ error: 'ERR script' })) as unknown as typeof fetch);
    await expect(redis.eval('x', [], [])).rejects.toThrow(RedisError);
  });
});

describe('SupabaseStore.settleUsage (Phase 2)', () => {
  const event: UsageEvent = {
    requestId: 'r', tenantId: 't', externalUserId: 'u', provider: 'openai', model: 'm', statusCode: 200, inputTokens: 1,
    outputTokens: 2, totalTokens: 3, estimatedCostUsd: 0.5, usageSource: 'provider_reported', latencyMs: 9, streaming: true,
    occurredAt: '2026-09-26T10:00:00.000Z',
  };
  const store = (f: (url: string, init: RequestInit) => Promise<Response>) =>
    new SupabaseStore('https://p.supabase.co', 'svc', f as unknown as typeof fetch);

  it('calls the settle_usage RPC with the service-role key and named parameters', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const s = store(async (url, init) => {
      seen = { url, init };
      return json(true);
    });
    expect(await s.settleUsage(event)).toBe(true);
    expect(seen!.url).toBe('https://p.supabase.co/rest/v1/rpc/settle_usage');
    expect(seen!.init.method).toBe('POST');
    expect((seen!.init.headers as Record<string, string>)['apikey']).toBe('svc');
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      p_request_id: 'r', p_tenant_id: 't', p_external_user_id: 'u', p_provider: 'openai', p_model: 'm', p_status_code: 200,
      p_input_tokens: 1, p_output_tokens: 2, p_total_tokens: 3, p_estimated_cost_usd: 0.5, p_usage_source: 'provider_reported',
      p_latency_ms: 9, p_streaming: true, p_created_at: '2026-09-26T10:00:00.000Z',
    });
  });
  it('returns false for an already-settled request', async () => {
    expect(await store(async () => json(false)).settleUsage(event)).toBe(false);
  });
  it('throws StoreError on HTTP errors, network failures and unexpected bodies', async () => {
    await expect(store(async () => json({}, 500)).settleUsage(event)).rejects.toThrow(StoreError);
    await expect(store(async () => { throw new Error('x'); }).settleUsage(event)).rejects.toThrow(StoreError);
    await expect(store(async () => json({ nope: 1 })).settleUsage(event)).rejects.toThrow(StoreError);
  });
});
