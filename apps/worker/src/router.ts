import type { Dependencies } from './deps';
import { errorResponse } from './errors';
import { handleProxyRequest } from './pipeline';

/** Maps method + path to a handler. Phase 1 exposes one proxy route and a health check. */
export async function route(request: Request, getDeps: () => Dependencies): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  if (pathname === '/v1/chat/completions') {
    if (request.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Use POST.', { allow: 'POST' });
    }
    return handleProxyRequest(request, getDeps());
  }

  return errorResponse(404, 'NOT_FOUND', 'Route not found.');
}
