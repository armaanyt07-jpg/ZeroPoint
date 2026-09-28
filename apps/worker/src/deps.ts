import { UpstashRedis, type RedisClient } from './redis';
import { Directory } from './directory';
import { ZeroPointError } from './errors';
import { SupabaseStore, type CircuitBreakerStore } from './store';
import type { SettlementDeps } from './settlement';
import type { Telemetry } from './telemetry';
import type { Env } from './env';
import type { UsageQueue } from './usage-queue';
import type { WebhookQueue } from './webhook-queue';
import { createDefaultRegistry, type ProviderRegistry } from '@zeropoint/providers';

/** Everything the request pipeline needs. Tests build this with fakes. */
export interface Dependencies {
  redis: RedisClient;
  directory: Directory;
  telemetry: Telemetry;
  providers: ProviderRegistry;
  encryptionKey: string;
  fetch: typeof fetch;
  /** Where usage events go for asynchronous settlement (FR-2.3). */
  usageQueue: UsageQueue;
  /** Where circuit-breaker webhook notifications go (FR-3.7). */
  webhookQueue: WebhookQueue;
  /** Records circuit-breaker trips for the audit trail (FR-3.4). */
  circuitBreakerStore: CircuitBreakerStore;
  /** Runs work after the response is returned (`ctx.waitUntil`). */
  defer: (work: Promise<unknown>) => void;
}

const REQUIRED: (keyof Env)[] = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CREDENTIAL_ENCRYPTION_KEY',
  'USAGE_QUEUE',
  'WEBHOOK_QUEUE',
];

/** Wires real infrastructure clients from Worker secrets/bindings. */
export function createDependencies(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  telemetry: Telemetry,
): Dependencies {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    // Names only, never values. Logged for the operator; clients get a generic message.
    console.error(JSON.stringify({ type: 'config_error', missing }));
    throw new ZeroPointError(500, 'CONFIGURATION_ERROR', 'The service is not configured correctly.');
  }
  const redis = new UpstashRedis(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  const store = new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const defer = (work: Promise<unknown>) => ctx.waitUntil(work);
  return {
    redis,
    directory: new Directory(redis, store, telemetry, defer),
    telemetry,
    providers: createDefaultRegistry(),
    encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
    fetch: (input, init) => fetch(input, init),
    usageQueue: {
      send: async (event) => {
        await env.USAGE_QUEUE.send(event);
      },
    },
    webhookQueue: {
      send: async (event) => {
        await env.WEBHOOK_QUEUE.send(event);
      },
    },
    circuitBreakerStore: store,
    defer,
  };
}

/** Wires the queue consumers' clients. Settlement is not latency-sensitive, so the timeouts are generous. */
export function createSettlementDependencies(env: Env, telemetry: Telemetry): SettlementDeps {
  const missing = (['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const).filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    console.error(JSON.stringify({ type: 'config_error', missing }));
    throw new ZeroPointError(500, 'CONFIGURATION_ERROR', 'The service is not configured correctly.');
  }
  return {
    redis: new UpstashRedis(
      env.UPSTASH_REDIS_REST_URL,
      env.UPSTASH_REDIS_REST_TOKEN,
      (input, init) => fetch(input, init),
      5000,
    ),
    store: new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
    telemetry,
    webhookQueue: {
      send: async (event) => {
        await env.WEBHOOK_QUEUE.send(event);
      },
    },
  };
}
