import type { LLMProviderAdapter } from '@zeropoint/providers';
import { ZeroPointError } from './errors';
import type { Telemetry } from './telemetry';

/**
 * Only these upstream response headers reach the client. An allow-list keeps
 * provider-identifying headers (openai-organization, openai-project,
 * x-request-id, server, cf-ray, ...) from leaking tenant/provider details (NFR-5.2).
 */
const RESPONSE_HEADER_ALLOW_LIST = ['content-type', 'cache-control'];

const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * Sends the adapter-built request upstream and returns a client-safe response.
 *
 * Success responses stream through: `response.body` is piped to the client
 * without being read into memory (SRS 2.3: no full buffering). Every error
 * becomes ZeroPoint's own `{ error: { code, message } }` shape (SRS sections 6
 * and 8), so clients parse one format and never see raw provider payloads.
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
  throw await normalizeProviderError(upstream, providerApiKey);
}

function passThrough(upstream: Response): Response {
  const headers = new Headers();
  for (const name of RESPONSE_HEADER_ALLOW_LIST) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function normalizeProviderError(upstream: Response, providerApiKey: string): Promise<ZeroPointError> {
  const { status } = upstream;

  // The tenant's own provider key was rejected: a configuration problem, not
  // the client's fault, and the body may contain key fragments. Hide it.
  if (status === 401 || status === 403) {
    return new ZeroPointError(502, 'PROVIDER_AUTH_ERROR', 'The provider rejected the credentials.');
  }
  if (status >= 500) {
    return new ZeroPointError(502, 'PROVIDER_ERROR', 'The LLM provider returned an error.');
  }

  // Other 4xx (bad request, unknown model, rate limit) help the caller. Keep the
  // status, and keep the provider's human-readable message after scrubbing it.
  const message =
    (await extractProviderMessage(upstream, providerApiKey)) ??
    (status === 429 ? 'The provider rate limit was reached.' : 'The provider rejected the request.');
  const retryAfter = upstream.headers.get('retry-after');
  return new ZeroPointError(
    status,
    status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_REQUEST_REJECTED',
    message,
    retryAfter && /^\d+$/.test(retryAfter) ? { 'retry-after': retryAfter } : {},
  );
}

/**
 * OpenAI, Anthropic and Gemini all report errors as `{"error": {"message": "..."}}`.
 * Only that one string is kept, never the whole body.
 */
async function extractProviderMessage(upstream: Response, providerApiKey: string): Promise<string | null> {
  try {
    const body = (await upstream.json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    if (typeof message !== 'string' || message.trim() === '') return null;
    return redactSecrets(message, providerApiKey).slice(0, MAX_ERROR_MESSAGE_LENGTH);
  } catch {
    return null;
  }
}

/**
 * Removes the exact provider key plus anything shaped like a provider key
 * (OpenAI "sk-...", Anthropic "sk-ant-...", Google "AIza..."). The pattern
 * pass catches keys the provider echoes back masked or partially, such as
 * "sk-proj-****abcd", which an exact-match replace would miss.
 */
export function redactSecrets(text: string, providerApiKey: string): string {
  return text
    .replaceAll(providerApiKey, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_*.-]{4,}/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, '[redacted]');
}
