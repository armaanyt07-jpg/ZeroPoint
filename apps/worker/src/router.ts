import { createDefaultRegistry } from '@zeropoint/providers';
import type { Dependencies } from './deps';
import { ZeroPointError, errorResponse } from './errors';
import { errorToResponse, handleProxyRequest } from './pipeline';
import type { Telemetry } from './telemetry';

/** Knows every provider's URL shape, so unknown paths get a 404 without needing any config. */
const KNOWN_PATHS = createDefaultRegistry();

/**
 * Maps method + path to a handler. Any path that a registered provider adapter
 * serves (OpenAI, Anthropic, Gemini...) goes through the proxy pipeline; the
 * pipeline then checks that `x-provider` matches that path.
 */
export async function route(
  request: Request,
  getDeps: () => Dependencies,
  telemetry: Telemetry,
  requestId: string = crypto.randomUUID(),
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/health') return health(request, getDeps);

  // Requests rejected here never reach the pipeline, so count them here to keep
  // requests_total = requests_allowed + requests_rejected.
  const reject = (error: ZeroPointError) => {
    telemetry.increment('requests_total');
    return withRequestId(errorToResponse(error, telemetry, requestId), requestId);
  };

  if (!KNOWN_PATHS.supportsPath(pathname)) {
    return reject(new ZeroPointError(404, 'NOT_FOUND', 'Route not found.'));
  }
  if (request.method !== 'POST') {
    return reject(new ZeroPointError(405, 'METHOD_NOT_ALLOWED', 'Use POST.', { allow: 'POST' }));
  }

  let deps: Dependencies;
  try {
    deps = getDeps();
  } catch (error) {
    return reject(error as ZeroPointError); // configuration errors are ZeroPointErrors
  }
  return withRequestId(await handleProxyRequest(request, deps, requestId), requestId);
}

/**
 * Readiness check: GET/HEAD only, and 503 unless the Worker is configured
 * (all required secrets present). It reports nothing about WHICH setting is
 * missing (that goes to the operator's logs) and does not call Redis or
 * Postgres, so it is cheap and cannot be used to load them. It is not counted
 * as proxy traffic.
 */
function health(request: Request, getDeps: () => Dependencies): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Use GET.', { allow: 'GET, HEAD' });
  }
  let status = 200;
  let body = { status: 'ok' };
  try {
    getDeps(); // validates configuration only; builds clients, makes no network calls
  } catch {
    status = 503;
    body = { status: 'unavailable' };
  }
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Adds x-request-id without touching the body, so streaming responses stay streaming. */
function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
