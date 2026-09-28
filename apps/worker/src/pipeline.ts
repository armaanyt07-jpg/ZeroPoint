import { assertUserAllowed, authenticate } from './auth';
import { assertWithinBudget, getCurrentSpend, resolveBudgetLimit } from './budget';
import { checkPatternHash, hashRequest, readCircuitState } from './circuit-breaker';
import { decryptProviderCredential } from './credentials';
import type { Dependencies } from './deps';
import { StoreError } from './store';
import { ZeroPointError, errorResponse, toErrorResponse } from './errors';
import { forwardToProvider } from './proxy';
import { recordAndNotify } from './settlement';
import type { Telemetry } from './telemetry';

/**
 * The request lifecycle (SRS sections 2.1 and 7):
 *
 *   authenticate -> pick provider -> [user + spend + circuit state, in parallel]
 *   -> user status -> circuit OPEN? -> budget -> hash request -> loop match?
 *   -> (await key) decrypt -> forward
 *
 * Metrics invariant: every request increments `requests_total` exactly once and
 * then exactly one of `requests_allowed` (a 2xx was returned to the client) or
 * `requests_rejected` (any error response).
 */
export async function handleProxyRequest(
  request: Request,
  deps: Dependencies,
  requestId?: string,
): Promise<Response> {
  const { telemetry } = deps;
  const startedAt = Date.now();
  // Also the settlement idempotency key (FR-2.4), so it must be a UUID.
  const id = requestId ?? crypto.randomUUID();
  telemetry.increment('requests_total');
  // FR-3.3 needs to hash the body (D1), so it's cloned before anything reads it.
  // The original `request` still reaches the adapter with its body untouched.
  const requestForHashing = request.clone();
  try {
    // 1. FR-1.1: who is calling? (401)
    const auth = await authenticate(request, deps.directory);

    // 2. FR-1.4: which provider? Explicit x-provider header (400 if missing/unsupported).
    const providerId = request.headers.get('x-provider')?.trim().toLowerCase();
    if (!providerId) {
      throw new ZeroPointError(400, 'MISSING_PROVIDER', 'The x-provider header is required.');
    }
    const adapter = deps.providers.get(providerId);
    if (!adapter || !(await adapter.authenticate(request))) {
      throw new ZeroPointError(400, 'UNSUPPORTED_PROVIDER', 'Unsupported provider or request.');
    }

    // 3. Everything below depends only on the tenant (known after step 1) and the
    //    provider (step 2), so the lookups run concurrently: one network round trip
    //    instead of several (NFR-5.1 latency target).
    //    The credential lookup is started now but only awaited after the policy
    //    checks, so a credential-store failure can never turn a 403/429 into a 503.
    const credentialLookup = deps.directory.getEncryptedCredential(auth.tenantId, adapter.id);
    credentialLookup.catch(() => {}); // avoid an unhandled rejection if a policy check throws first
    const [user, spend, circuit] = await Promise.all([
      deps.directory.getEndUser(auth.tenantId, auth.userId),
      getCurrentSpend(deps.redis, telemetry, auth.tenantId, auth.userId),
      readCircuitState(deps.redis, telemetry, auth.tenantId, auth.userId),
    ]);

    // 4. Blocked/suspended users: 403.
    assertUserAllowed(user);

    // 5. FR-3.5: circuit already OPEN (a prior velocity or loop trip)? Stop here,
    //    before budget or the provider are ever touched (429).
    if (circuit.open) {
      throw new ZeroPointError(429, 'CIRCUIT_OPEN', 'AI request temporarily blocked by ZeroPoint protection.', {
        'retry-after': String(circuit.retryAfterSeconds),
      });
    }

    // 6. FR-1.2: over budget? Stop here, before the provider is ever contacted (429).
    assertWithinBudget(spend, resolveBudgetLimit(user, auth.tenantDefaultBudgetUsd));

    // 7. FR-3.3: hash the request; three in a row trips the loop breaker and blocks
    //    THIS request too (it's the one that completed the pattern). A body over
    //    the cap (D1) is exempt from hash tracking, not treated as a match/miss.
    const hash = await hashRequest(adapter.id, new URL(request.url).pathname, requestForHashing.body);
    if (hash !== null) {
      const trigger = await checkPatternHash(
        deps.redis,
        telemetry,
        auth.tenantId,
        auth.userId,
        hash,
        Date.now(),
        auth.tenantPolicy,
      );
      if (trigger) {
        deps.defer(
          recordAndNotify(auth.tenantId, auth.userId, trigger, auth.tenantPolicy, {
            store: deps.circuitBreakerStore,
            webhookQueue: deps.webhookQueue,
            telemetry,
          }),
        );
        throw new ZeroPointError(429, 'CIRCUIT_OPEN', 'AI request temporarily blocked by ZeroPoint protection.', {
          'retry-after': String(auth.tenantPolicy.circuitBreakerDurationSeconds),
        });
      }
    }

    // 8. FR-1.3: swap in the tenant's provider credential and forward.
    const providerKey = await decryptProviderCredential(
      await credentialLookup,
      deps.encryptionKey,
      auth.tenantId,
      adapter.id,
    );
    const response = await forwardToProvider(adapter, request, providerKey, deps.fetch, telemetry, {
      requestId: id,
      tenantId: auth.tenantId,
      externalUserId: auth.userId,
      startedAt,
      queue: deps.usageQueue,
      defer: deps.defer,
    });
    telemetry.increment('requests_allowed', { provider: adapter.id });
    return response;
  } catch (error) {
    return errorToResponse(error, telemetry, requestId);
  }
}

/**
 * Turns any thrown error into a safe client response and records the rejection.
 * Used by the pipeline and the router so 4xx, 5xx, 404 and 405 are all counted.
 */
export function errorToResponse(error: unknown, telemetry: Telemetry, requestId?: string): Response {
  if (error instanceof ZeroPointError) {
    telemetry.increment('requests_rejected', { code: error.code });
    if (error.code === 'BUDGET_EXCEEDED') telemetry.increment('budget_rejections');
    return toErrorResponse(error);
  }
  if (error instanceof StoreError) {
    // Auth/authorization data unavailable: we cannot safely allow the request.
    console.error(JSON.stringify({ type: 'store_error', request_id: requestId, message: error.message }));
    telemetry.increment('requests_rejected', { code: 'SERVICE_UNAVAILABLE' });
    return errorResponse(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }
  // Log only the error type: messages could in theory contain sensitive text.
  console.error(
    JSON.stringify({ type: 'unhandled_error', request_id: requestId, name: (error as Error)?.name }),
  );
  telemetry.increment('requests_rejected', { code: 'INTERNAL_ERROR' });
  return errorResponse(500, 'INTERNAL_ERROR', 'Internal error.');
}
