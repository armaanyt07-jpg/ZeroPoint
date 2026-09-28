import { encryptSecret, generateEncryptionKey, sha256Hex } from '@zeropoint/crypto';
import { createDefaultRegistry } from '@zeropoint/providers';
import type { CircuitBreakerEvent, TenantPolicy, UsageEvent, WebhookEvent } from '@zeropoint/types';
import { vi } from 'vitest';
import { runLuaScript } from './lua-redis';
import { Directory } from '../apps/worker/src/directory';
import type { Dependencies } from '../apps/worker/src/deps';
import type { RedisClient } from '../apps/worker/src/redis';
import { RedisError } from '../apps/worker/src/redis';
import {
  StoreError,
  type ApiKeyRecord,
  type CircuitBreakerStore,
  type EndUserRecord,
  type TenantStore,
} from '../apps/worker/src/store';
import type { MetricName, Telemetry } from '../apps/worker/src/telemetry';
import type { UsageQueue } from '../apps/worker/src/usage-queue';
import type { UsageStore } from '../apps/worker/src/store';
import type { SettlementDeps } from '../apps/worker/src/settlement';
import type { WebhookQueue } from '../apps/worker/src/webhook-queue';

/** The SRS 4.3 tenant defaults ($2/60s, 15-minute circuit, no webhook configured). */
export const DEFAULT_TENANT_POLICY: TenantPolicy = {
  velocityLimitUsd: 2,
  velocityWindowSeconds: 60,
  circuitBreakerDurationSeconds: 900,
  webhookUrl: null,
};

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
  /** Number of upcoming EVALs that fail (a flapping Redis during settlement). */
  evalFailures = 0;
  evalCalls = 0;

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
  /** Executes the real Lua script text (see lua-redis.ts) against the in-memory data. */
  async eval(script: string, keys: string[], args: (string | number)[]) {
    this.evalCalls++;
    if (this.failing) throw new RedisError('down');
    if (this.evalFailures > 0) {
      this.evalFailures--;
      throw new RedisError('flapping');
    }
    return runLuaScript(script, keys, args, this.data);
  }
  async set(key: string, value: string, ttl?: number) {
    if (this.hangOnSet) return new Promise<void>(() => {});
    if (this.failing) throw new RedisError('down');
    this.data.set(key, value);
    this.ttls.set(key, ttl);
  }
}

export class FakeStore implements TenantStore, CircuitBreakerStore {
  apiKeys = new Map<string, ApiKeyRecord>();
  endUsers = new Map<string, EndUserRecord>();
  credentials = new Map<string, string>();
  policies = new Map<string, TenantPolicy>();
  circuitBreakerEvents: CircuitBreakerEvent[] = [];
  failing = false;
  /** Fail only the credential table, to test error precedence. */
  failCredentials = false;
  calls = { apiKey: 0, endUser: 0, credential: 0, policy: 0 };

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
  async findTenantPolicy(tenantId: string) {
    this.calls.policy++;
    this.check();
    return this.policies.get(tenantId) ?? DEFAULT_TENANT_POLICY;
  }
  async recordCircuitBreakerEvent(event: CircuitBreakerEvent) {
    this.check();
    this.circuitBreakerEvents.push(event);
  }
}

/** In-memory WebhookQueue. `failures` = how many upcoming sends throw. */
export class FakeWebhookQueue implements WebhookQueue {
  sent: WebhookEvent[] = [];
  failures = 0;
  attempts = 0;
  async send(event: WebhookEvent) {
    this.attempts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('queue down');
    }
    this.sent.push(event);
  }
}

/** In-memory UsageQueue. `failures` = how many upcoming sends throw. */
export class FakeUsageQueue implements UsageQueue {
  sent: UsageEvent[] = [];
  failures = 0;
  attempts = 0;
  async send(event: UsageEvent) {
    this.attempts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('queue down');
    }
    this.sent.push(event);
  }
}

/** In-memory settle_usage: idempotent by request id, like the SQL function. */
export class FakeUsageStore implements UsageStore, CircuitBreakerStore, Pick<TenantStore, 'findTenantPolicy'> {
  logs = new Map<string, UsageEvent>();
  spend = new Map<string, number>();
  policies = new Map<string, TenantPolicy>();
  circuitBreakerEvents: CircuitBreakerEvent[] = [];
  failures = 0;
  calls = 0;
  async settleUsage(event: UsageEvent) {
    this.calls++;
    if (this.failures > 0) {
      this.failures--;
      throw new StoreError('db down');
    }
    if (this.logs.has(event.requestId)) return false;
    this.logs.set(event.requestId, event);
    const key = `${event.tenantId}:${event.externalUserId}`;
    this.spend.set(key, (this.spend.get(key) ?? 0) + event.estimatedCostUsd);
    return true;
  }
  async findTenantPolicy(tenantId: string): Promise<TenantPolicy | null> {
    return this.policies.get(tenantId) ?? DEFAULT_TENANT_POLICY;
  }
  async recordCircuitBreakerEvent(event: CircuitBreakerEvent) {
    this.circuitBreakerEvents.push(event);
  }
}

export class FakeTelemetry implements Telemetry {
  events: { metric: MetricName; tags: Record<string, string>; value: number }[] = [];
  increment(metric: MetricName, tags: Record<string, string> = {}, value = 1) {
    this.events.push({ metric, tags, value });
  }
  /** Sum of the values recorded for a metric. */
  sum(metric: MetricName) {
    return this.events.filter((e) => e.metric === metric).reduce((total, e) => total + e.value, 0);
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
  queue: FakeUsageQueue;
  webhookQueue: FakeWebhookQueue;
  usageStore: FakeUsageStore;
  deps: Dependencies;
  encryptionKey: string;
  /** Background work handed to ctx.waitUntil (cache writes, usage tracking). */
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
    policy: DEFAULT_TENANT_POLICY,
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
  const queue = new FakeUsageQueue();
  const webhookQueue = new FakeWebhookQueue();
  const usageStore = new FakeUsageStore();
  const defer = (work: Promise<unknown>) => void deferred.push(work);
  const deps: Dependencies = {
    redis,
    directory: new Directory(redis, store, telemetry, defer),
    telemetry,
    providers: createDefaultRegistry(),
    encryptionKey,
    fetch: providerFetch as unknown as typeof fetch,
    usageQueue: queue,
    webhookQueue,
    circuitBreakerStore: store,
    defer,
  };
  const flush = async () => {
    await Promise.all(deferred.splice(0));
  };
  return {
    redis,
    store,
    telemetry,
    providerFetch,
    queue,
    webhookQueue,
    usageStore,
    deps,
    encryptionKey,
    deferred,
    flush,
  };
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

/** What the queue consumer needs, wired to the harness's fakes. */
export function settlementDeps(h: Harness): SettlementDeps {
  return { redis: h.redis, store: h.usageStore, telemetry: h.telemetry, webhookQueue: h.webhookQueue };
}

/** A queue message wrapper that records ack/retry, like Cloudflare's Message. */
export class FakeMessage {
  acked = false;
  retried: { delaySeconds?: number } | null = null;
  constructor(
    readonly body: unknown,
    readonly attempts = 1,
  ) {}
  ack() {
    this.acked = true;
  }
  retry(options: { delaySeconds?: number } = {}) {
    this.retried = options;
  }
}

/** Builds an SSE-shaped provider response from text or byte chunks, delivered one per read. */
export function sseResponse(chunks: (string | Uint8Array)[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
  });
  return new Response(body, { headers: { 'content-type': contentType } });
}
