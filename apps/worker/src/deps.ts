import { UpstashRedis, type RedisClient } from './redis';
import { Directory } from './directory';
import { ZeroPointError } from './errors';
import { SupabaseStore } from './store';
import { ConsoleTelemetry, type Telemetry } from './telemetry';
import type { Env } from './env';
import { createDefaultRegistry, type ProviderRegistry } from '@zeropoint/providers';

/** Everything the request pipeline needs. Tests build this with fakes. */
export interface Dependencies {
  redis: RedisClient;
  directory: Directory;
  telemetry: Telemetry;
  providers: ProviderRegistry;
  encryptionKey: string;
  fetch: typeof fetch;
}

const REQUIRED: (keyof Env)[] = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CREDENTIAL_ENCRYPTION_KEY',
];

/** Wires real infrastructure clients from Worker secrets/bindings. */
export function createDependencies(env: Env): Dependencies {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    // Names only, never values. Logged for the operator; clients get a generic message.
    console.error(JSON.stringify({ type: 'config_error', missing }));
    throw new ZeroPointError(500, 'CONFIGURATION_ERROR', 'The service is not configured correctly.');
  }
  const telemetry = new ConsoleTelemetry();
  const redis = new UpstashRedis(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  const store = new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  return {
    redis,
    directory: new Directory(redis, store, telemetry),
    telemetry,
    providers: createDefaultRegistry(),
    encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
    fetch: (input, init) => fetch(input, init),
  };
}
