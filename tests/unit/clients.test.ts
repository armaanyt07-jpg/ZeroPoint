import { describe, expect, it, vi } from 'vitest';
import { RedisError, UpstashRedis } from '../../apps/worker/src/redis';
import { StoreError, SupabaseStore } from '../../apps/worker/src/store';

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
});
