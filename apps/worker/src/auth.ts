import type { TenantPolicy } from '@zeropoint/types';
import { PROXY_KEY_PREFIX, sha256Hex } from '@zeropoint/crypto';
import { isValidExternalUserId, lastUsedKey } from '@zeropoint/schemas';
import type { Directory } from './directory';
import { ZeroPointError } from './errors';
import type { RedisClient } from './redis';
import type { ApiKeyUsageStore, EndUserRecord } from './store';
import type { Telemetry } from './telemetry';

export { PROXY_KEY_PREFIX };

/** Who is calling, established by authenticate(). */
export interface AuthContext {
  tenantId: string;
  apiKeyId: string;
  /** External end-user id from the x-user-id header. */
  userId: string;
  tenantDefaultBudgetUsd: number;
  /** Phase 3 governance policy (velocity/circuit-breaker/webhook), read with the key. */
  tenantPolicy: TenantPolicy;
}

const unauthorized = () =>
  new ZeroPointError(401, 'UNAUTHORIZED', 'Invalid or missing credentials.');

/** Parses `Authorization: Bearer <token>`. Returns null when absent or malformed. */
export function extractBearerToken(headers: Headers): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get('authorization')?.trim() ?? '');
  return match?.[1] ?? null;
}

/** FR-1.1: returns the x-user-id value, or null when missing/blank. */
export function extractUserId(headers: Headers): string | null {
  const value = headers.get('x-user-id')?.trim();
  return value ? value : null;
}

/**
 * FR-1.1 header authentication, following the SRS flow exactly:
 * Authorization -> extract token -> hash -> resolve tenant/key -> x-user-id.
 * Every failure is a 401 with the same message so callers learn nothing
 * about which step failed.
 */
export async function authenticate(request: Request, directory: Directory): Promise<AuthContext> {
  const token = extractBearerToken(request.headers);
  // Cheap format check first: garbage tokens never cost a hash or a lookup.
  if (!token || !token.startsWith(PROXY_KEY_PREFIX)) throw unauthorized();

  // Only the SHA-256 digest of a proxy key is ever stored or looked up (NFR-5.2).
  const keyHash = await sha256Hex(token);
  const key = await directory.getApiKey(keyHash);
  if (!key || key.status !== 'active') throw unauthorized();

  const userId = extractUserId(request.headers);
  if (!userId) throw unauthorized();
  if (!isValidExternalUserId(userId)) {
    throw new ZeroPointError(400, 'INVALID_USER_ID', 'Invalid x-user-id header.');
  }

  return {
    tenantId: key.tenantId,
    apiKeyId: key.apiKeyId,
    userId,
    tenantDefaultBudgetUsd: key.defaultBudgetUsd,
    tenantPolicy: key.policy,
  };
}

/** Authorization step: blocked or suspended users get 403. Unknown users are treated as active. */
export function assertUserAllowed(user: EndUserRecord | null): void {
  if (user && user.status !== 'active') {
    throw new ZeroPointError(403, 'USER_BLOCKED', 'This user is not permitted to make requests.');
  }
}

/** At most one `api_keys.last_used_at` write per key per this many seconds (Phase 4, D11). */
export const LAST_USED_THROTTLE_SECONDS = 300;

/** SET NX: 1 if this call claimed the throttle window (so it should write), else 0. */
export const LAST_USED_SCRIPT = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then
  return 1
end
return 0
`;

/**
 * Records that a proxy key was used, for the dashboard's key list. Runs under
 * `ctx.waitUntil`, so it never adds latency, and never throws: it is bookkeeping,
 * not governance. Redis throttles it to one database write per key per window.
 */
export async function recordKeyUse(
  redis: RedisClient,
  store: ApiKeyUsageStore,
  telemetry: Telemetry,
  apiKeyId: string,
  now = Date.now(),
): Promise<void> {
  let claimed: boolean;
  try {
    claimed = Number(await redis.eval(LAST_USED_SCRIPT, [lastUsedKey(apiKeyId)], [LAST_USED_THROTTLE_SECONDS])) === 1;
  } catch {
    telemetry.increment('redis_failures', { operation: 'last_used' });
    return; // without the throttle every request would write; skip instead
  }
  if (!claimed) return;
  try {
    await store.touchApiKey(apiKeyId, new Date(now).toISOString());
  } catch (error) {
    console.error(JSON.stringify({ type: 'last_used_write_failed', name: (error as Error)?.name }));
  }
}
