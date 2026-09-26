import { sha256Hex } from '@zeropoint/crypto';
import type { Directory } from './directory';
import { ZeroPointError } from './errors';
import type { EndUserRecord } from './store';

export const PROXY_KEY_PREFIX = 'pk_live_';
const MAX_USER_ID_LENGTH = 128;

/** Who is calling, established by authenticate(). */
export interface AuthContext {
  tenantId: string;
  apiKeyId: string;
  /** External end-user id from the x-user-id header. */
  userId: string;
  tenantDefaultBudgetUsd: number;
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
  if (userId.length > MAX_USER_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(userId)) {
    throw new ZeroPointError(400, 'INVALID_USER_ID', 'Invalid x-user-id header.');
  }

  return {
    tenantId: key.tenantId,
    apiKeyId: key.apiKeyId,
    userId,
    tenantDefaultBudgetUsd: key.defaultBudgetUsd,
  };
}

/** Authorization step: blocked or suspended users get 403. Unknown users are treated as active. */
export function assertUserAllowed(user: EndUserRecord | null): void {
  if (user && user.status !== 'active') {
    throw new ZeroPointError(403, 'USER_BLOCKED', 'This user is not permitted to make requests.');
  }
}
