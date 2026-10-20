/**
 * Redis key names shared by the Worker (which reads them) and the dashboard
 * (which deletes cache entries after an administrative change, docs/PHASE_4_PLAN.md
 * D8). One definition, so the two can never drift apart.
 */

/** Read-through cache of `api_keys` + tenant policy, by SHA-256 key hash. */
export const apiKeyCacheKey = (keyHash: string) => `cache:apikey:${keyHash}`;

/** Read-through cache of one end user's budget and status. */
export const endUserCacheKey = (tenantId: string, externalUserId: string) =>
  `cache:enduser:${tenantId}:${externalUserId}`;

/** Read-through cache of a provider credential (ciphertext only, never plaintext). */
export const providerCredentialCacheKey = (tenantId: string, provider: string) =>
  `cache:providercred:${tenantId}:${provider}`;

/** Read-through cache of the whole `model_prices` table (Phase 4, D9). */
export const PRICING_CACHE_KEY = 'cache:pricing';

/** Throttle marker for `api_keys.last_used_at` writes (Phase 4, D11). */
export const lastUsedKey = (apiKeyId: string) => `lastused:${apiKeyId}`;

/**
 * Providers the Worker has adapters for (`packages/providers` registry). The
 * dashboard offers exactly these for credentials and prices; a test keeps the
 * two lists in sync.
 */
export const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** `x-user-id` / `end_users.external_user_id` rules, shared by the Worker (FR-1.1) and the dashboard. */
export const MAX_EXTERNAL_USER_ID_LENGTH = 128;

export function isValidExternalUserId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_EXTERNAL_USER_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}
