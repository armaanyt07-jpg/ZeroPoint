import { describe, expect, it } from 'vitest';
import { assertUserAllowed, authenticate, extractBearerToken, extractUserId } from '../../apps/worker/src/auth';
import { ZeroPointError } from '../../apps/worker/src/errors';
import { DEFAULT_TENANT_POLICY, PROXY_KEY, TENANT_ID, USER_ID, createHarness, proxyRequest } from '../helpers';
import { sha256Hex } from '@zeropoint/crypto';

describe('header parsing', () => {
  it('extracts bearer tokens case-insensitively', () => {
    expect(extractBearerToken(new Headers({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(extractBearerToken(new Headers({ authorization: 'bearer abc' }))).toBe('abc');
  });
  it('returns null for missing, non-bearer or malformed values', () => {
    expect(extractBearerToken(new Headers())).toBeNull();
    expect(extractBearerToken(new Headers({ authorization: 'Basic abc' }))).toBeNull();
    expect(extractBearerToken(new Headers({ authorization: 'Bearer' }))).toBeNull();
    expect(extractBearerToken(new Headers({ authorization: 'Bearer a b' }))).toBeNull();
  });
  it('extracts and trims x-user-id; blank is null', () => {
    expect(extractUserId(new Headers({ 'x-user-id': ' user_1 ' }))).toBe('user_1');
    expect(extractUserId(new Headers({ 'x-user-id': '   ' }))).toBeNull();
    expect(extractUserId(new Headers())).toBeNull();
  });
});

describe('authenticate (FR-1.1)', () => {
  it('resolves tenant and user for a valid key', async () => {
    const h = await createHarness();
    expect(await authenticate(proxyRequest(), h.deps.directory)).toEqual({
      tenantId: TENANT_ID, apiKeyId: 'key-1', userId: USER_ID, tenantDefaultBudgetUsd: 20,
      tenantPolicy: DEFAULT_TENANT_POLICY,
    });
  });

  const expect401 = async (req: Request, mutate?: (h: Awaited<ReturnType<typeof createHarness>>) => void) => {
    const h = await createHarness();
    mutate?.(h);
    const err = await authenticate(req, h.deps.directory).catch((e) => e);
    expect(err).toBeInstanceOf(ZeroPointError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  };

  it('401: missing Authorization', () => expect401(proxyRequest({ headers: { authorization: null } })));
  it('401: not a Bearer header', () => expect401(proxyRequest({ headers: { authorization: 'Basic abc' } })));
  it('401: wrong key prefix, without touching the database', async () => {
    const h = await createHarness();
    await expect(
      authenticate(proxyRequest({ headers: { authorization: 'Bearer sk-not-a-proxy-key' } }), h.deps.directory),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.store.calls.apiKey).toBe(0);
  });
  it('401: unknown key', () => expect401(proxyRequest({ headers: { authorization: 'Bearer pk_live_unknown' } })));
  it('401: revoked key', () =>
    expect401(proxyRequest(), async (h) => {
      h.store.apiKeys.set(await sha256Hex(PROXY_KEY), {
        apiKeyId: 'k',
        tenantId: TENANT_ID,
        status: 'revoked',
        defaultBudgetUsd: 20,
        policy: DEFAULT_TENANT_POLICY,
      });
    }));
  it('401: missing x-user-id', () => expect401(proxyRequest({ headers: { 'x-user-id': null } })));

  it('400: overlong or control-character user ids', async () => {
    const h = await createHarness();
    for (const bad of ['a'.repeat(129), 'bad\tid']) {
      await expect(
        authenticate(proxyRequest({ headers: { 'x-user-id': bad } }), h.deps.directory),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_USER_ID' });
    }
  });
});

describe('assertUserAllowed', () => {
  it('allows active and unknown users', () => {
    expect(() => assertUserAllowed(null)).not.toThrow();
    expect(() => assertUserAllowed({ id: 'u', budgetLimitUsd: null, status: 'active' })).not.toThrow();
  });
  it.each(['blocked', 'suspended'] as const)('403 for %s users', (status) => {
    expect(() => assertUserAllowed({ id: 'u', budgetLimitUsd: null, status })).toThrowError(
      expect.objectContaining({ status: 403, code: 'USER_BLOCKED' }),
    );
  });
});
