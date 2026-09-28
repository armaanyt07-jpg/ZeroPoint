import { asRecord } from './usage';

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
export function streamingPost(
  url: string,
  headers: Headers,
  body: ReadableStream | Uint8Array | null,
): Request {
  return new Request(url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
}

/** Largest request body ZeroPoint will read to look for `stream: true` (bytes). */
export const MAX_INSPECTED_REQUEST_BYTES = 1024 * 1024;

/**
 * OpenAI only reports token usage on a stream if the request sets
 * `stream_options.include_usage = true`. Without it a streamed response carries no
 * usage and the spend could not be governed, so for `stream: true` requests we set it.
 *
 * Cost of this decision (docs/PHASE_2.md, D2): the request body is read (up to
 * `maxBytes`) rather than passed through untouched, and OpenAI then appends one
 * extra final chunk (empty `choices`, populated `usage`) to the client's stream.
 * Everything else is left byte-for-byte alone: non-streaming requests, bodies that
 * aren't JSON objects, and bodies over the cap are forwarded unchanged.
 */
export async function withStreamUsageOptIn(
  body: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_INSPECTED_REQUEST_BYTES,
): Promise<ReadableStream<Uint8Array> | Uint8Array | null> {
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  while (size <= maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      finished = true;
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }

  if (!finished) {
    // Too large to inspect: replay what was read, then keep streaming the rest.
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const object = asRecord(parsed);
    if (object && object['stream'] === true) {
      const options = asRecord(object['stream_options']) ?? {};
      if (options['include_usage'] !== true) {
        object['stream_options'] = { ...options, include_usage: true };
        return new TextEncoder().encode(JSON.stringify(object));
      }
    }
  } catch {
    // Not JSON: forward exactly what the client sent and let the provider reject it.
  }
  return bytes;
}
