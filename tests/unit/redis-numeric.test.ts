import { describe, expect, it } from 'vitest';
import { RedisError, UpstashRedis } from '../../apps/worker/src/redis';
import { getCurrentSpend } from '../../apps/worker/src/budget';
import { assertWithinBudget } from '../../apps/worker/src/budget';
import { FakeTelemetry, TENANT_ID, USER_ID } from '../helpers';

const redisReturning = (result: unknown) =>
  new UpstashRedis('https://r.example', 't', (async () =>
    new Response(JSON.stringify({ result }), { status: 200 })) as unknown as typeof fetch);

describe('UpstashRedis.get result types (review: Critical 3)', () => {
  it('returns strings unchanged', async () => {
    expect(await redisReturning('12.5').get('k')).toBe('12.5');
  });
  it('does NOT drop numeric results', async () => {
    expect(await redisReturning(25).get('k')).toBe('25');
    expect(await redisReturning(0.5).get('k')).toBe('0.5');
    expect(await redisReturning(0).get('k')).toBe('0');
  });
  it('maps null to null', async () => {
    expect(await redisReturning(null).get('k')).toBeNull();
  });
  it('rejects unexpected result types instead of mis-reading them', async () => {
    await expect(redisReturning({ a: 1 }).get('k')).rejects.toThrow(RedisError);
    await expect(redisReturning([1]).get('k')).rejects.toThrow(RedisError);
  });

  it('an over-budget numeric counter still triggers the 429 guardrail', async () => {
    const spend = await getCurrentSpend(redisReturning(25), new FakeTelemetry(), TENANT_ID, USER_ID);
    expect(spend).toBe(25);
    expect(() => assertWithinBudget(spend, 20)).toThrowError(expect.objectContaining({ status: 429 }));
  });
  it('an unexpected result type fails open with telemetry, not silently', async () => {
    const t = new FakeTelemetry();
    expect(await getCurrentSpend(redisReturning({ a: 1 }), t, TENANT_ID, USER_ID)).toBe(0);
    expect(t.count('redis_failures')).toBe(1);
  });
});
