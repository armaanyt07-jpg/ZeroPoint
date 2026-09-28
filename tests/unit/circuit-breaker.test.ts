import { describe, expect, it } from 'vitest';
import {
  HASH_SCRIPT,
  MAX_HASHED_REQUEST_BYTES,
  VELOCITY_SCRIPT,
  checkPatternHash,
  checkVelocity,
  circuitKey,
  hashRequest,
  hashesKey,
  readCircuitState,
  velocityKey,
} from '../../apps/worker/src/circuit-breaker';
import { DEFAULT_TENANT_POLICY, FakeRedis, FakeTelemetry, TENANT_ID, USER_ID } from '../helpers';

const streamOf = (bytes: Uint8Array | string): ReadableStream<Uint8Array> => {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
};

describe('the real velocity/hash Lua scripts, run on a Lua VM (fengari)', () => {
  it('VELOCITY_SCRIPT sums costs in the window and opens once the total exceeds the threshold', async () => {
    const redis = new FakeRedis();
    const vKey = velocityKey(TENANT_ID, USER_ID);
    const cKey = circuitKey(TENANT_ID, USER_ID);
    const run = (now: number, cost: string, requestId: string) =>
      redis.eval(VELOCITY_SCRIPT, [vKey, cKey], [now, 60000, cost, requestId, '2.00000000', 900, now + 900000, 'velocity', 65]);

    expect(await run(1000, '1.00000000', 'r1')).toBe(0);
    expect(await run(2000, '1.00000000', 'r2')).toBe(0); // total 2.00, not > 2.00
    expect(await run(3000, '0.00000001', 'r3')).toBe(1); // total just over threshold: opens
    expect(redis.data.get(cKey)).toBe(`velocity:${3000 + 900000}`);
  });

  it('VELOCITY_SCRIPT prunes entries older than the window before summing', async () => {
    const redis = new FakeRedis();
    const vKey = velocityKey(TENANT_ID, USER_ID);
    const cKey = circuitKey(TENANT_ID, USER_ID);
    const run = (now: number, cost: string, requestId: string) =>
      redis.eval(VELOCITY_SCRIPT, [vKey, cKey], [now, 60000, cost, requestId, '2.00000000', 900, now + 900000, 'velocity', 65]);

    expect(await run(0, '1.50000000', 'old')).toBe(0); // under threshold alone
    // 61s later "old" has aged out of the 60s window. If it still stacked, 1.5+1.5=3.0
    // would trip; because it was pruned, this new $1.50 alone (1.5, not > 2.00) does not.
    expect(await run(61000, '1.50000000', 'new')).toBe(0);
    expect(JSON.parse(redis.data.get(vKey)!)).toEqual([['new:1.50000000', 61000]]);
  });

  it("VELOCITY_SCRIPT never re-triggers while the circuit is already open (D3)", async () => {
    const redis = new FakeRedis();
    const vKey = velocityKey(TENANT_ID, USER_ID);
    const cKey = circuitKey(TENANT_ID, USER_ID);
    redis.data.set(cKey, 'velocity:99999999999');
    expect(await redis.eval(VELOCITY_SCRIPT, [vKey, cKey], [1000, 60000, '5.00000000', 'r1', '2.00000000', 900, 901000, 'velocity', 65])).toBe(0);
    expect(redis.data.get(cKey)).toBe('velocity:99999999999'); // untouched
  });

  it('HASH_SCRIPT keeps only the last five hashes and opens on three consecutive matches', async () => {
    const redis = new FakeRedis();
    const hKey = hashesKey(TENANT_ID, USER_ID);
    const cKey = circuitKey(TENANT_ID, USER_ID);
    const run = (hash: string) => redis.eval(HASH_SCRIPT, [hKey, cKey], [hash, 905, 900, 900000, 'loop']);

    expect(await run('a')).toBe(0); // [a]
    expect(await run('b')).toBe(0); // [b,a]
    expect(await run('a')).toBe(0); // [a,b,a]: newest three not all equal
    expect(await run('a')).toBe(0); // [a,a,b,a]: newest three (a,a,b) not all equal
    expect(await run('a')).toBe(1); // [a,a,a,b,a]: newest three all equal -> opens
    expect(redis.data.get(cKey)).toBe('loop:900000');
    expect(JSON.parse(redis.data.get(hKey)!)).toHaveLength(5); // exactly the cap
  });

  it('HASH_SCRIPT never re-triggers while the circuit is already open, but keeps recording', async () => {
    const redis = new FakeRedis();
    const hKey = hashesKey(TENANT_ID, USER_ID);
    const cKey = circuitKey(TENANT_ID, USER_ID);
    redis.data.set(cKey, 'loop:99999999999');
    expect(await redis.eval(HASH_SCRIPT, [hKey, cKey], ['x', 905, 900, 900000, 'loop'])).toBe(0);
    expect(JSON.parse(redis.data.get(hKey)!)).toEqual(['x']); // still tracked
    expect(redis.data.get(cKey)).toBe('loop:99999999999'); // untouched
  });

  it('is atomic: each script is one EVAL, matching what real Redis executes', () => {
    expect(VELOCITY_SCRIPT.match(/redis\.call/g)!.length).toBeGreaterThan(1);
    expect(HASH_SCRIPT.match(/redis\.call/g)!.length).toBeGreaterThan(1);
  });
});

describe('readCircuitState', () => {
  it('returns closed when no key is set', async () => {
    const redis = new FakeRedis();
    expect(await readCircuitState(redis, new FakeTelemetry(), TENANT_ID, USER_ID)).toEqual({ open: false });
  });

  it('parses reason and computes retry-after from the embedded expiry', async () => {
    const redis = new FakeRedis();
    const expiresAt = Date.now() + 42_000;
    redis.data.set(circuitKey(TENANT_ID, USER_ID), `loop:${expiresAt}`);
    const state = await readCircuitState(redis, new FakeTelemetry(), TENANT_ID, USER_ID);
    expect(state.open).toBe(true);
    expect(state.reason).toBe('loop');
    expect(state.retryAfterSeconds).toBeGreaterThanOrEqual(41);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(42);
  });

  it('fails open (NFR-5.3) on a Redis error, and emits redis_failures', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    const telemetry = new FakeTelemetry();
    expect(await readCircuitState(redis, telemetry, TENANT_ID, USER_ID)).toEqual({ open: false });
    expect(telemetry.events[0]).toMatchObject({ metric: 'redis_failures', tags: { operation: 'circuit_read', outcome: 'fail_open' } });
  });

  it('fails open on a corrupt value instead of trusting garbage', async () => {
    const redis = new FakeRedis();
    redis.data.set(circuitKey(TENANT_ID, USER_ID), 'not-a-valid-value');
    expect(await readCircuitState(redis, new FakeTelemetry(), TENANT_ID, USER_ID)).toEqual({ open: false });
  });
});

describe('checkVelocity / checkPatternHash (the JS wrappers around the scripts)', () => {
  it('checkVelocity returns a trigger only on the call that crosses the threshold', async () => {
    const redis = new FakeRedis();
    const telemetry = new FakeTelemetry();
    const now = Date.now();
    expect(await checkVelocity(redis, telemetry, TENANT_ID, USER_ID, 'r1', 1, now, DEFAULT_TENANT_POLICY)).toBeNull();
    const trigger = await checkVelocity(redis, telemetry, TENANT_ID, USER_ID, 'r2', 1.01, now, DEFAULT_TENANT_POLICY);
    expect(trigger).toEqual({ reason: 'velocity', openedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() });
  });

  it('checkVelocity fails open on a Redis error', async () => {
    const redis = new FakeRedis();
    redis.evalFailures = 1;
    const telemetry = new FakeTelemetry();
    expect(await checkVelocity(redis, telemetry, TENANT_ID, USER_ID, 'r1', 100, Date.now(), DEFAULT_TENANT_POLICY)).toBeNull();
    expect(telemetry.events[0]).toMatchObject({ tags: { operation: 'velocity_check', outcome: 'fail_open' } });
  });

  it('checkPatternHash returns a trigger only on the third consecutive match', async () => {
    const redis = new FakeRedis();
    const telemetry = new FakeTelemetry();
    const now = Date.now();
    expect(await checkPatternHash(redis, telemetry, TENANT_ID, USER_ID, 'h', now, DEFAULT_TENANT_POLICY)).toBeNull();
    expect(await checkPatternHash(redis, telemetry, TENANT_ID, USER_ID, 'h', now, DEFAULT_TENANT_POLICY)).toBeNull();
    const trigger = await checkPatternHash(redis, telemetry, TENANT_ID, USER_ID, 'h', now, DEFAULT_TENANT_POLICY);
    expect(trigger).toEqual({ reason: 'loop', openedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() });
  });

  it('checkPatternHash fails open on a Redis error (request-path, NFR-5.3)', async () => {
    const redis = new FakeRedis();
    redis.evalFailures = 1;
    const telemetry = new FakeTelemetry();
    expect(await checkPatternHash(redis, telemetry, TENANT_ID, USER_ID, 'h', Date.now(), DEFAULT_TENANT_POLICY)).toBeNull();
    expect(telemetry.events[0]).toMatchObject({ tags: { operation: 'hash_check', outcome: 'fail_open' } });
  });
});

describe('hashRequest (FR-3.3 normalized request representation, D1)', () => {
  it('is deterministic for the same provider/path/body', async () => {
    const a = await hashRequest('openai', '/v1/chat/completions', streamOf('{"a":1}'));
    const b = await hashRequest('openai', '/v1/chat/completions', streamOf('{"a":1}'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs by provider, path, or body', async () => {
    const base = await hashRequest('openai', '/v1/chat/completions', streamOf('{"a":1}'));
    expect(await hashRequest('anthropic', '/v1/chat/completions', streamOf('{"a":1}'))).not.toBe(base);
    expect(await hashRequest('openai', '/v1/messages', streamOf('{"a":1}'))).not.toBe(base);
    expect(await hashRequest('openai', '/v1/chat/completions', streamOf('{"a":2}'))).not.toBe(base);
  });

  it('handles a null body (no request body)', async () => {
    expect(await hashRequest('openai', '/v1/chat/completions', null)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a body over the cap is exempt (returns null), never partially hashed', async () => {
    const oversized = new Uint8Array(MAX_HASHED_REQUEST_BYTES + 1);
    expect(await hashRequest('openai', '/v1/chat/completions', streamOf(oversized), MAX_HASHED_REQUEST_BYTES)).toBeNull();
  });

  it('a body exactly at the cap is still hashed', async () => {
    const exact = new Uint8Array(MAX_HASHED_REQUEST_BYTES);
    expect(await hashRequest('openai', '/v1/chat/completions', streamOf(exact), MAX_HASHED_REQUEST_BYTES)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cancels the stream once the cap is exceeded, rather than reading it all', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await hashRequest('openai', '/p', body, 25)).toBeNull();
    expect(cancelled).toBe(true);
  });
});
