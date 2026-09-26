import { describe, expect, it } from 'vitest';
import {
  assertWithinBudget, getCurrentSpend, isOverBudget, resolveBudgetLimit, spendKey,
} from '../../apps/worker/src/budget';
import { FakeRedis, FakeTelemetry, TENANT_ID, USER_ID } from '../helpers';

describe('budget comparison (FR-1.2)', () => {
  it('blocks when spend >= limit (equal counts as exceeded)', () => {
    expect(isOverBudget(20, 20)).toBe(true);
    expect(isOverBudget(20.0001, 20)).toBe(true);
    expect(isOverBudget(19.9999, 20)).toBe(false);
    expect(isOverBudget(0, 0)).toBe(true);
  });
  it('assertWithinBudget throws 429 BUDGET_EXCEEDED', () => {
    expect(() => assertWithinBudget(5, 5)).toThrowError(
      expect.objectContaining({ status: 429, code: 'BUDGET_EXCEEDED' }),
    );
    expect(() => assertWithinBudget(4, 5)).not.toThrow();
  });
});

describe('resolveBudgetLimit', () => {
  it('prefers the per-user limit, including 0', () => {
    expect(resolveBudgetLimit({ id: 'u', budgetLimitUsd: 5, status: 'active' }, 20)).toBe(5);
    expect(resolveBudgetLimit({ id: 'u', budgetLimitUsd: 0, status: 'active' }, 20)).toBe(0);
  });
  it('falls back to the tenant default when null or when the user is unknown', () => {
    expect(resolveBudgetLimit({ id: 'u', budgetLimitUsd: null, status: 'active' }, 20)).toBe(20);
    expect(resolveBudgetLimit(null, 20)).toBe(20);
  });
});

describe('getCurrentSpend', () => {
  it('uses the SRS key pattern spend:{tenant}:{user}', () => {
    expect(spendKey(TENANT_ID, USER_ID)).toBe(`spend:${TENANT_ID}:${USER_ID}`);
  });
  it('reads the counter, and treats a missing counter as 0', async () => {
    const redis = new FakeRedis();
    const t = new FakeTelemetry();
    expect(await getCurrentSpend(redis, t, TENANT_ID, USER_ID)).toBe(0);
    redis.data.set(spendKey(TENANT_ID, USER_ID), '12.3456');
    expect(await getCurrentSpend(redis, t, TENANT_ID, USER_ID)).toBe(12.3456);
    expect(t.count('redis_failures')).toBe(0);
  });
  it('does not leak spend between tenants', async () => {
    const redis = new FakeRedis();
    redis.data.set(spendKey('other-tenant', USER_ID), '99');
    expect(await getCurrentSpend(redis, new FakeTelemetry(), TENANT_ID, USER_ID)).toBe(0);
  });
  it('fails open (spend 0) with telemetry when Redis is down or the value is corrupt', async () => {
    const redis = new FakeRedis();
    const t = new FakeTelemetry();
    redis.failing = true;
    expect(await getCurrentSpend(redis, t, TENANT_ID, USER_ID)).toBe(0);
    redis.failing = false;
    redis.data.set(spendKey(TENANT_ID, USER_ID), 'NaN-garbage');
    expect(await getCurrentSpend(redis, t, TENANT_ID, USER_ID)).toBe(0);
    expect(t.count('redis_failures')).toBe(2);
  });
});
