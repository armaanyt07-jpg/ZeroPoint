import { assertUserAllowed, authenticate } from './auth';
import { assertWithinBudget, getCurrentSpend, resolveBudgetLimit } from './budget';
import { resolveProviderCredential } from './credentials';
import type { Dependencies } from './deps';
import { StoreError } from './store';
import { ZeroPointError, errorResponse, toErrorResponse } from './errors';
import { forwardToProvider } from './proxy';

/**
 * The Phase 1 request lifecycle (SRS sections 2.1 and 7, minus the circuit
 * breaker which arrives in Phase 3):
 *
 *   authenticate -> pick provider -> user status -> budget -> provider key -> forward
 */
export async function handleProxyRequest(request: Request, deps: Dependencies): Promise<Response> {
  const { telemetry } = deps;
  telemetry.increment('requests_total');
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

    // 3. Load the user record and current spend in parallel (independent lookups).
    const [user, spend] = await Promise.all([
      deps.directory.getEndUser(auth.tenantId, auth.userId),
      getCurrentSpend(deps.redis, telemetry, auth.tenantId, auth.userId),
    ]);

    // 4. Blocked/suspended users: 403.
    assertUserAllowed(user);

    // 5. FR-1.2: over budget? Stop here, before the provider is ever contacted (429).
    assertWithinBudget(spend, resolveBudgetLimit(user, auth.tenantDefaultBudgetUsd));

    // 6. FR-1.3: swap in the tenant's provider credential and forward.
    const providerKey = await resolveProviderCredential(
      deps.directory,
      deps.encryptionKey,
      auth.tenantId,
      adapter.id,
    );
    telemetry.increment('requests_allowed', { provider: adapter.id });
    return await forwardToProvider(adapter, request, providerKey, deps.fetch, telemetry);
  } catch (error) {
    return toSafeResponse(error, deps);
  }
}

function toSafeResponse(error: unknown, deps: Dependencies): Response {
  if (error instanceof ZeroPointError) {
    deps.telemetry.increment('requests_rejected', { code: error.code });
    if (error.code === 'BUDGET_EXCEEDED') deps.telemetry.increment('budget_rejections');
    return toErrorResponse(error);
  }
  if (error instanceof StoreError) {
    // Auth/authorization data unavailable: we cannot safely allow the request.
    console.error(JSON.stringify({ type: 'store_error', message: error.message }));
    return errorResponse(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }
  // Log only the error type: messages could in theory contain sensitive text.
  console.error(JSON.stringify({ type: 'unhandled_error', name: (error as Error)?.name }));
  return errorResponse(500, 'INTERNAL_ERROR', 'Internal error.');
}
