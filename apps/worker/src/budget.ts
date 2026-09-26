import { ZeroPointError } from './errors';
import type { RedisClient } from './redis';
import type { EndUserRecord } from './store';
import type { Telemetry } from './telemetry';

/** Redis key for a user's spend counter (SRS section 10). Always tenant-scoped. */
export const spendKey = (tenantId: string, userId: string) => `spend:${tenantId}:${userId}`;

/** Per-user budget wins; otherwise the tenant default applies. */
export function resolveBudgetLimit(user: EndUserRecord | null, tenantDefaultUsd: number): number {
  return user?.budgetLimitUsd ?? tenantDefaultUsd;
}

/** FR-1.2: the request is blocked once spend reaches the limit (>=, not >). */
export function isOverBudget(currentSpendUsd: number, budgetLimitUsd: number): boolean {
  return currentSpendUsd >= budgetLimitUsd;
}

/**
 * Reads the spend counter. A missing counter means $0 spent. If Redis is down
 * or returns garbage we FAIL OPEN (NFR-5.3): spend is treated as 0 so a
 * governance outage can't take customers' apps offline, and we emit telemetry.
 *
 * NOTE: in Phase 1 nothing writes this counter yet (settlement is Phase 2),
 * so in practice spend stays 0 until then.
 */
export async function getCurrentSpend(
  redis: RedisClient,
  telemetry: Telemetry,
  tenantId: string,
  userId: string,
): Promise<number> {
  try {
    const raw = await redis.get(spendKey(tenantId, userId));
    if (raw === null) return 0;
    const spend = Number(raw);
    if (!Number.isFinite(spend) || spend < 0) throw new Error('corrupt spend value');
    return spend;
  } catch {
    telemetry.increment('redis_failures', { operation: 'spend_read', outcome: 'fail_open' });
    return 0;
  }
}

/** Throws 429 BUDGET_EXCEEDED before any provider is contacted. */
export function assertWithinBudget(currentSpendUsd: number, budgetLimitUsd: number): void {
  if (isOverBudget(currentSpendUsd, budgetLimitUsd)) {
    throw new ZeroPointError(429, 'BUDGET_EXCEEDED', 'User spending limit exceeded.');
  }
}
