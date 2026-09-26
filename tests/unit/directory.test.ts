import { describe, expect, it } from 'vitest';
import { CACHE_TTL_SECONDS, NEGATIVE_CACHE_TTL_SECONDS } from '../../apps/worker/src/directory';
import { StoreError } from '../../apps/worker/src/store';
import { PROXY_KEY, TENANT_ID, createHarness } from '../helpers';
import { sha256Hex } from '@zeropoint/crypto';

describe('Directory (Redis cache with Postgres fallback)', () => {
  it('cache miss loads from Postgres and populates Redis with a TTL', async () => {
    const h = await createHarness();
    const hash = await sha256Hex(PROXY_KEY);
    const key = await h.deps.directory.getApiKey(hash);
    expect(key?.tenantId).toBe(TENANT_ID);
    expect(h.store.calls.apiKey).toBe(1);
    expect(h.redis.data.has(`cache:apikey:${hash}`)).toBe(true);
    expect(h.redis.ttls.get(`cache:apikey:${hash}`)).toBe(CACHE_TTL_SECONDS);
  });

  it('cache hit does not touch Postgres', async () => {
    const h = await createHarness();
    const hash = await sha256Hex(PROXY_KEY);
    await h.deps.directory.getApiKey(hash);
    await h.deps.directory.getApiKey(hash);
    expect(h.store.calls.apiKey).toBe(1);
  });

  it('caches "not found" briefly so bad keys cannot hammer the database', async () => {
    const h = await createHarness();
    expect(await h.deps.directory.getApiKey('f'.repeat(64))).toBeNull();
    expect(await h.deps.directory.getApiKey('f'.repeat(64))).toBeNull();
    expect(h.store.calls.apiKey).toBe(1);
    expect(h.redis.ttls.get(`cache:apikey:${'f'.repeat(64)}`)).toBe(NEGATIVE_CACHE_TTL_SECONDS);
  });

  it('falls back to Postgres when Redis is down, and records redis_failures', async () => {
    const h = await createHarness();
    h.redis.failing = true;
    const key = await h.deps.directory.getApiKey(await sha256Hex(PROXY_KEY));
    expect(key?.tenantId).toBe(TENANT_ID);
    expect(h.telemetry.count('redis_failures')).toBe(2); // read + write
  });

  it('treats a corrupt cache entry as a miss', async () => {
    const h = await createHarness();
    const hash = await sha256Hex(PROXY_KEY);
    h.redis.data.set(`cache:apikey:${hash}`, '{not json');
    expect((await h.deps.directory.getApiKey(hash))?.tenantId).toBe(TENANT_ID);
  });

  it('propagates database failures (auth data must not fail open)', async () => {
    const h = await createHarness();
    h.store.failing = true;
    await expect(h.deps.directory.getApiKey('a'.repeat(64))).rejects.toThrow(StoreError);
  });

  it('scopes end-user and credential cache keys by tenant', async () => {
    const h = await createHarness();
    await h.deps.directory.getEndUser(TENANT_ID, 'u1');
    await h.deps.directory.getEncryptedCredential(TENANT_ID, 'openai');
    expect(h.redis.data.has(`cache:enduser:${TENANT_ID}:u1`)).toBe(true);
    expect(h.redis.data.has(`cache:providercred:${TENANT_ID}:openai`)).toBe(true);
  });
});
