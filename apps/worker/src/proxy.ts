import type { LLMProviderAdapter } from '@zeropoint/providers';
import { ZeroPointError } from './errors';
import type { Telemetry } from './telemetry';

/**
 * Sends the adapter-built request upstream and returns a client-safe response.
 *
 * Success responses are returned as-is: `response.body` is a stream that is
 * piped to the client without being read into memory (SRS 2.3: no full
 * buffering). Error responses are sanitized (SRS section 8) because a provider
 * error such as "Incorrect API key provided: sk-...abcd" would leak part of
 * the tenant's credential.
 */
export async function forwardToProvider(
  adapter: LLMProviderAdapter,
  clientRequest: Request,
  providerApiKey: string,
  fetchImpl: typeof fetch,
  telemetry: Telemetry,
): Promise<Response> {
  const upstreamRequest = await adapter.buildProviderRequest(clientRequest, providerApiKey);

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamRequest);
  } catch {
    telemetry.increment('provider_errors', { provider: adapter.id, kind: 'network' });
    throw new ZeroPointError(502, 'PROVIDER_UNREACHABLE', 'Could not reach the LLM provider.');
  }

  if (upstream.ok) return passThrough(upstream);

  telemetry.increment('provider_errors', { provider: adapter.id, status: String(upstream.status) });

  // The tenant's own provider key was rejected: a configuration problem, not
  // the client's fault, and the body may contain key fragments. Hide it.
  if (upstream.status === 401 || upstream.status === 403) {
    throw new ZeroPointError(502, 'PROVIDER_AUTH_ERROR', 'The provider rejected the credentials.');
  }
  if (upstream.status >= 500) {
    throw new ZeroPointError(502, 'PROVIDER_ERROR', 'The LLM provider returned an error.');
  }

  // Other 4xx (bad request, rate limit, unknown model) help the caller; pass
  // them through after scrubbing the credential in case the provider echoed it.
  const text = (await upstream.text()).replaceAll(providerApiKey, '[redacted]');
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
  });
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) headers.set('retry-after', retryAfter);
  return new Response(text, { status: upstream.status, headers });
}

function passThrough(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  headers.delete('set-cookie'); // provider cookies have no business reaching the client
  return new Response(upstream.body, { status: upstream.status, headers });
}
