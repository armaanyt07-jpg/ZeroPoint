import { encryptSecret, generateEncryptionKey, sha256Hex } from '@zeropoint/crypto';
import { createDefaultRegistry } from '@zeropoint/providers';
import { vi } from 'vitest';
import { Directory } from '../apps/worker/src/directory';
import type { Dependencies } from '../apps/worker/src/deps';
import type { RedisClient } from '../apps/worker/src/redis';
import { RedisError } from '../apps/worker/src/redis';
import {
  StoreError,
  type ApiKeyRecord,
  type EndUserRecord,
  type TenantStore,
} from '../apps/worker/src/store';
import type { MetricName, Telemetry } from '../apps/worker/src/telemetry';

export class FakeRedis implements RedisClient {
  data = new Map<string, string>();
  ttls = new Map<string, number | undefined>();
  failing = false;
  getCalls: string[] = [];
  /** When set, every GET takes this long, so tests can observe concurrency. */
  getDelayMs = 0;
  /** When true, SET never completes (a slow Redis): used to prove writes are off the critical path. */
  hangOnSet = false;
  private inFlight = 0;
  maxInFlight = 0;

  async get(key: string) {
    this.getCalls.push(key);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.getDelayMs) await new Promise((r) => setTimeout(r, this.getDelayMs));
      if (this.failing) throw new RedisError('down');
      return this.data.get(key) ?? null;
    } finally {
      this.inFlight--;
    }
  }
  async set(key: string, value: string, ttl?: number) {
    if (this.hangOnSet) return new Promise<void>(() => {});
    if (this.failing) throw new RedisError('down');
    this.data.set(key, value);
    this.ttls.set(key, ttl);
  }
}

export class FakeStore implements TenantStore {
  apiKeys = new Map<string, ApiKeyRecord>();
  endUsers = new Map<string, EndUserRecord>();
  credentials = new Map<string, string>();
  failing = false;
  /** Fail only the credential table, to test error precedence. */
  failCredentials = false;
  calls = { apiKey: 0, endUser: 0, credential: 0 };

  private check() {
    if (this.failing) throw new StoreError('db down');
  }
  async findApiKeyByHash(hash: string) {
    this.calls.apiKey++;
    this.check();
    return this.apiKeys.get(hash) ?? null;
  }
  async findEndUser(tenantId: string, userId: string) {
    this.calls.endUser++;
    this.check();
    return this.endUsers.get(`${tenantId}:${userId}`) ?? null;
  }
  async findProviderCredential(tenantId: string, provider: string) {
    this.calls.credential++;
    this.check();
    if (this.failCredentials) throw new StoreError('credentials table down');
    return this.credentials.get(`${tenantId}:${provider}`) ?? null;
  }
}

export class FakeTelemetry implements Telemetry {
  events: { metric: MetricName; tags: Record<string, string> }[] = [];
  increment(metric: MetricName, tags: Record<string, string> = {}) {
    this.events.push({ metric, tags });
  }
  count(metric: MetricName) {
    return this.events.filter((e) => e.metric === metric).length;
  }
  /** Counts of the request-accounting metrics, for invariant checks. */
  accounting() {
    return {
      total: this.count('requests_total'),
      allowed: this.count('requests_allowed'),
      rejected: this.count('requests_rejected'),
    };
  }
}

export const TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const PROXY_KEY = 'pk_live_test_secret_value';
export const PROVIDER_KEY = 'sk-provider-secret-1234567890';
export const USER_ID = 'user_123';

export interface Harness {
  redis: FakeRedis;
  store: FakeStore;
  telemetry: FakeTelemetry;
  providerFetch: ReturnType<typeof vi.fn>;
  deps: Dependencies;
  encryptionKey: string;
  /** Background work handed to ctx.waitUntil (cache writes). */
  deferred: Promise<unknown>[];
  /** Waits for all background work, like the Workers runtime does after the response. */
  flush(): Promise<void>;
}

/** A tenant with one active key, an OpenAI credential, and a $20 default budget. */
export async function createHarness(): Promise<Harness> {
  const redis = new FakeRedis();
  const store = new FakeStore();
  const telemetry = new FakeTelemetry();
  const encryptionKey = generateEncryptionKey();

  store.apiKeys.set(await sha256Hex(PROXY_KEY), {
    apiKeyId: 'key-1',
    tenantId: TENANT_ID,
    status: 'active',
    defaultBudgetUsd: 20,
  });
  store.credentials.set(
    `${TENANT_ID}:openai`,
    await encryptSecret(PROVIDER_KEY, encryptionKey, `${TENANT_ID}:openai`),
  );

  const providerFetch = vi.fn(
    async (_req: Request) =>
      new Response('{"id":"chatcmpl-1"}', { headers: { 'content-type': 'application/json' } }),
  );

  const deferred: Promise<unknown>[] = [];
  const deps: Dependencies = {
    redis,
    directory: new Directory(redis, store, telemetry, (work) => void deferred.push(work)),
    telemetry,
    providers: createDefaultRegistry(),
    encryptionKey,
    fetch: providerFetch as unknown as typeof fetch,
  };
  const flush = async () => {
    await Promise.all(deferred.splice(0));
  };
  return { redis, store, telemetry, providerFetch, deps, encryptionKey, deferred, flush };
}

export function proxyRequest(
  overrides: { headers?: Record<string, string | null>; body?: string; method?: string; path?: string } = {},
): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${PROXY_KEY}`,
    'x-user-id': USER_ID,
    'x-provider': 'openai',
    'content-type': 'application/json',
  };
  for (const [k, v] of Object.entries(overrides.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  const method = overrides.method ?? 'POST';
  return new Request(`https://zeropoint.example${overrides.path ?? '/v1/chat/completions'}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: overrides.body ?? '{"model":"gpt-4o","messages":[]}' } : {}),
  });
}

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

/** Gives the harness tenant an encrypted credential for another provider. */
export async function addCredential(h: Harness, provider: string, plaintext: string): Promise<void> {
  h.store.credentials.set(
    `${TENANT_ID}:${provider}`,
    await encryptSecret(plaintext, h.encryptionKey, `${TENANT_ID}:${provider}`),
  );
}
