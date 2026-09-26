/** Helpers shared by provider adapters. */

/**
 * Copies only the named headers from the client request. An allow-list is safer
 * than a block-list: anything unexpected (proxy key, x-user-id, cookies, cf-*
 * headers) is dropped by default.
 */
export function copyAllowedHeaders(request: Request, names: readonly string[]): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** True for a POST that carries a Bearer credential (the proxy key, checked elsewhere). */
export function isPostWithBearer(request: Request): boolean {
  return (
    request.method === 'POST' && /^Bearer\s+\S+/i.test(request.headers.get('authorization') ?? '')
  );
}

/**
 * The body is passed as a stream, so large prompts are never buffered in memory.
 * `duplex: 'half'` is required by the fetch spec when streaming a request body.
 */
export function streamingPost(url: string, headers: Headers, body: ReadableStream | null): Request {
  return new Request(url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
}
