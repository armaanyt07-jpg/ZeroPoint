import {
  PRICING_CACHE_KEY,
  apiKeyCacheKey,
  endUserCacheKey,
  providerCredentialCacheKey,
} from '@zeropoint/schemas';
import type { ModelPricing, ProviderId } from '@zeropoint/types';
import type { RedisClient } from './redis';
import type { ApiKeyRecord, EndUserRecord, TenantStore } from './store';
import type { Telemetry } from './telemetry';

/**
 * How long looked-up records stay in Redis. Trade-off: a shorter TTL means
 * revocations/blocks take effect sooner but the database is hit more often.
 */
export const CACHE_TTL_SECONDS = 60;
/** Unknown keys are remembered briefly so bad keys can't hammer the database. */
export const NEGATIVE_CACHE_TTL_SECONDS = 30;

/**
 * Read-through cache in front of PostgreSQL.
 *
 * "Read-through": look in Redis first; on a miss, load from Postgres and store
 * the result in Redis for next time. This keeps the hot path fast (SRS NFR-5.1)
 * while Postgres stays the source of truth (SRS 4.1).
 *
 * Cache entries are wrapped as {"v": <record or null>} so "this key does not
 * exist" (null) can be cached too, which is called negative caching.
 * A Redis failure never breaks a request here: we just go to the database.
 */
export class Directory {
  constructor(
    private readonly redis: RedisClient,
    private readonly store: TenantStore,
    private readonly telemetry: Telemetry,
    /**
     * Runs background work without delaying the response. In production this is
     * `ctx.waitUntil`, which keeps the Worker alive until the promise settles.
     */
    private readonly defer: (work: Promise<unknown>) => void = (work) => void work,
  ) {}

  getApiKey(keyHash: string): Promise<ApiKeyRecord | null> {
    return this.readThrough(apiKeyCacheKey(keyHash), () => this.store.findApiKeyByHash(keyHash));
  }

  getEndUser(tenantId: string, externalUserId: string): Promise<EndUserRecord | null> {
    return this.readThrough(endUserCacheKey(tenantId, externalUserId), () =>
      this.store.findEndUser(tenantId, externalUserId),
    );
  }

  /** Cached value is ciphertext only; plaintext provider keys are never put in Redis. */
  getEncryptedCredential(tenantId: string, provider: ProviderId): Promise<string | null> {
    return this.readThrough(providerCredentialCacheKey(tenantId, provider), () =>
      this.store.findProviderCredential(tenantId, provider),
    );
  }

  /** The whole price table, one cache entry (it is small and changes rarely). */
  async getModelPrices(): Promise<ModelPricing[]> {
    return (await this.readThrough(PRICING_CACHE_KEY, () => this.store.findModelPrices())) ?? [];
  }

  private async readThrough<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) {
        const parsed = JSON.parse(cached) as { v: T | null };
        return parsed.v;
      }
    } catch {
      this.telemetry.increment('redis_failures', { operation: 'cache_read' });
    }

    const value = await load(); // a database error propagates to the caller
    // The cache write is not on the critical path: the caller already has its
    // answer, so we hand the write to `defer` instead of awaiting it.
    const ttl = value === null ? NEGATIVE_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS;
    this.defer(
      this.redis.set(key, JSON.stringify({ v: value }), ttl).catch(() => {
        this.telemetry.increment('redis_failures', { operation: 'cache_write' });
      }),
    );
    return value;
  }
}
