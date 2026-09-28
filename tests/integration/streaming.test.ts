import { createDefaultRegistry } from '@zeropoint/providers';
import type { ModelPricing, UsageEvent } from '@zeropoint/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spendKey } from '../../apps/worker/src/budget';
import worker from '../../apps/worker/src/index';
import { handleProxyRequest } from '../../apps/worker/src/pipeline';
import { handleUsageBatch } from '../../apps/worker/src/settlement';
import {
  FakeMessage, PROVIDER_KEY, TENANT_ID, USER_ID, addCredential, createHarness, errorCode, proxyRequest, settlementDeps,
  sseResponse, type Harness,
} from '../helpers';

/** Test-only prices (NOT real prices, NOT shipped): $1 per million input tokens, $2 per million output. */
const PRICES: ModelPricing[] = ['openai', 'anthropic', 'gemini'].map((provider) => ({
  provider, model: 'fixture-model', inputPerMillionTokens: 1, outputPerMillionTokens: 2,
}));

const REQUEST_ID = '99999999-9999-9999-9999-999999999999';
const enc = new TextEncoder();

const OPENAI_CHUNKS = [
  'data: {"model":"fixture-model","choices":[{"delta":{"content":"SECRET-OUTPUT"}}],"usage":null}\n\n',
  'data: {"model":"fixture-model","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}\n\n',
  'data: [DONE]\n\n',
];

async function priced(): Promise<Harness> {
  const h = await createHarness();
  h.deps.providers = createDefaultRegistry(PRICES);
  return h;
}

async function readAll(response: Response): Promise<string> {
  return await response.text();
}

/** A provider stream the test controls chunk by chunk. */
function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    response: () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    push: (text: string) => controller.enqueue(enc.encode(text)),
    close: () => controller.close(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('dual-stream piping (FR-2.1)', () => {
  it('the client receives the provider stream unchanged while usage is extracted from Stream B', async () => {
    const h = await priced();
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    const res = await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await readAll(res)).toBe(OPENAI_CHUNKS.join(''));
    await h.flush();
    expect(h.queue.sent).toHaveLength(1);
    expect(h.queue.sent[0]).toMatchObject({
      requestId: REQUEST_ID, tenantId: TENANT_ID, externalUserId: USER_ID, provider: 'openai', model: 'fixture-model',
      statusCode: 200, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, estimatedCostUsd: 0.002,
      usageSource: 'provider_reported', streaming: true,
    });
  });

  it('is NOT fully buffered: the first chunk reaches the client before the provider has finished', async () => {
    const h = await priced();
    const provider = controlledStream();
    h.providerFetch.mockResolvedValue(provider.response());
    const res = await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID);
    const reader = res.body!.getReader();

    provider.push(OPENAI_CHUNKS[0]!); // the provider has NOT closed the stream
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(OPENAI_CHUNKS[0]);
    expect(h.queue.sent).toHaveLength(0); // and nothing is settled mid-stream

    provider.push(OPENAI_CHUNKS[1]!);
    provider.push(OPENAI_CHUNKS[2]!);
    provider.close();
    while (!(await reader.read()).done);
    await h.flush();
    expect(h.queue.sent[0]).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
  });

  it('a client that disconnects mid-stream does not stop usage collection: Stream B is drained to the end', async () => {
    const h = await priced();
    const provider = controlledStream();
    h.providerFetch.mockResolvedValue(provider.response());
    const res = await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID);
    const reader = res.body!.getReader();

    provider.push(OPENAI_CHUNKS[0]!);
    await reader.read();
    // Not awaited: per the Streams spec a tee branch's cancel() only settles once BOTH branches
    // are done, i.e. after Stream B has drained. The runtime doesn't await it either.
    const cancelled = reader.cancel('client went away');

    provider.push(OPENAI_CHUNKS[1]!); // the provider keeps going (and keeps billing)
    provider.push(OPENAI_CHUNKS[2]!);
    provider.close();
    await h.flush();
    await cancelled;
    expect(h.queue.sent[0]).toMatchObject({ inputTokens: 1000, outputTokens: 500, usageSource: 'provider_reported' });
  });

  it('SSE events split across chunks are handled end to end', async () => {
    const h = await priced();
    const whole = enc.encode(OPENAI_CHUNKS.join(''));
    const pieces = Array.from({ length: Math.ceil(whole.length / 7) }, (_, i) => whole.slice(i * 7, i * 7 + 7));
    h.providerFetch.mockResolvedValue(sseResponse(pieces));
    const res = await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID);
    expect(await readAll(res)).toBe(OPENAI_CHUNKS.join(''));
    await h.flush();
    expect(h.queue.sent[0]).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
  });

  it('emits streaming_requests, token_usage and estimated_spend', async () => {
    const h = await priced();
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    await readAll(await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID));
    await h.flush();
    expect(h.telemetry.count('streaming_requests')).toBe(1);
    expect(h.telemetry.sum('token_usage')).toBe(1500);
    expect(h.telemetry.sum('estimated_spend')).toBe(0.002);
    expect(h.telemetry.accounting()).toEqual({ total: 1, allowed: 1, rejected: 0 });
  });
});

describe('providers end to end', () => {
  it('Anthropic: usage from message_start + message_delta', async () => {
    const h = await priced();
    await addCredential(h, 'anthropic', 'sk-ant-secret-1234567890');
    h.providerFetch.mockResolvedValue(
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"fixture-model","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const res = await handleProxyRequest(
      proxyRequest({ path: '/v1/messages', headers: { 'x-provider': 'anthropic' } }), h.deps, REQUEST_ID,
    );
    await readAll(res);
    await h.flush();
    expect(h.queue.sent[0]).toMatchObject({ provider: 'anthropic', inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.002 });
  });

  it('Gemini: usageMetadata, with the model taken from the URL when the body has none', async () => {
    const h = await priced();
    await addCredential(h, 'gemini', 'AIzaSyFakeFakeFakeFake123');
    h.providerFetch.mockResolvedValue(
      sseResponse(['data: {"candidates":[],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":500}}\r\n\r\n']),
    );
    const res = await handleProxyRequest(
      proxyRequest({ path: '/v1beta/models/fixture-model:streamGenerateContent?alt=sse', headers: { 'x-provider': 'gemini' } }),
      h.deps, REQUEST_ID,
    );
    await readAll(res);
    await h.flush();
    expect(h.queue.sent[0]).toMatchObject({ provider: 'gemini', model: 'fixture-model', inputTokens: 1000, outputTokens: 500, usageSource: 'provider_reported' });
  });
});

describe('non-streaming responses (D1)', () => {
  it('are teed too: the client gets the exact JSON, usage is queued with streaming=false', async () => {
    const h = await priced();
    const body = '{"model":"fixture-model","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}';
    h.providerFetch.mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } }));
    const res = await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID);
    expect(await readAll(res)).toBe(body);
    await h.flush();
    expect(h.queue.sent[0]).toMatchObject({ streaming: false, inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.002 });
    expect(h.telemetry.count('streaming_requests')).toBe(0);
  });
});

describe('usage_source and unpriced models (D3)', () => {
  it('with the shipped (empty) price table, tokens are recorded but cost is 0 and the source is unknown', async () => {
    const h = await createHarness(); // default registry: no prices
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    await readAll(await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID));
    await h.flush();
    expect(h.queue.sent[0]).toMatchObject({ inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0, usageSource: 'unknown' });
  });

  it('a stream with no usage frames is still logged: unknown, zero tokens', async () => {
    const h = await priced();
    h.providerFetch.mockResolvedValue(sseResponse(['data: {"choices":[]}\n\n', 'data: [DONE]\n\n']));
    await readAll(await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID));
    await h.flush();
    expect(h.queue.sent[0]).toMatchObject({ totalTokens: 0, estimatedCostUsd: 0, usageSource: 'unknown' });
  });
});

describe('OpenAI usage opt-in reaches the provider (D2)', () => {
  it('a stream:true request is forwarded with stream_options.include_usage = true', async () => {
    const h = await priced();
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    await readAll(await handleProxyRequest(proxyRequest({ body: '{"model":"m","stream":true}' }), h.deps, REQUEST_ID));
    const upstream = h.providerFetch.mock.calls[0]![0] as Request;
    expect(JSON.parse(await upstream.text())).toEqual({ model: 'm', stream: true, stream_options: { include_usage: true } });
  });

  it('a non-streaming request is forwarded byte-for-byte (Phase 1 behaviour)', async () => {
    const h = await priced();
    const body = '{ "model": "m",   "messages": [] }';
    await handleProxyRequest(proxyRequest({ body }), h.deps, REQUEST_ID);
    expect(await (h.providerFetch.mock.calls[0]![0] as Request).text()).toBe(body);
  });
});

describe('queue failures never affect the client (SRS 8)', () => {
  it('a transient failure is retried in the background and then succeeds', async () => {
    const h = await priced();
    h.queue.failures = 1;
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    const res = await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID);
    expect(await readAll(res)).toBe(OPENAI_CHUNKS.join(''));
    await h.flush();
    expect(h.queue.sent).toHaveLength(1);
    expect(h.queue.attempts).toBe(2);
    expect(h.telemetry.events.filter((e) => e.metric === 'queue_failures').map((e) => e.tags['final'])).toEqual(['false']);
  });

  it('a permanent failure still delivers the whole stream to the client, emits queue_failures and logs only ids and numbers', async () => {
    const h = await priced();
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void logged.push(line));
    h.queue.failures = 99;
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    const res = await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID);
    expect(res.status).toBe(200);
    expect(await readAll(res)).toBe(OPENAI_CHUNKS.join(''));
    await h.flush();
    expect(h.queue.sent).toHaveLength(0);
    expect(h.telemetry.count('queue_failures')).toBe(3);
    const lost = JSON.parse(logged.find((l) => l.includes('usage_event_lost'))!);
    expect(lost).toMatchObject({ request_id: REQUEST_ID, total_tokens: 1500 });
    expect(logged.join('')).not.toContain('SECRET-OUTPUT');
  });
});

describe('what is NOT settled', () => {
  it('rejected requests (401, 429) and provider errors (D6) produce no usage event', async () => {
    const h = await priced();
    await handleProxyRequest(proxyRequest({ headers: { authorization: 'Bearer pk_live_wrong' } }), h.deps, REQUEST_ID);
    h.redis.data.set(spendKey(TENANT_ID, USER_ID), '20');
    expect(await errorCode(await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID))).toBe('BUDGET_EXCEEDED');
    h.redis.data.clear();
    h.providerFetch.mockResolvedValue(new Response('{"error":{"message":"boom"}}', { status: 500 }));
    expect((await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID)).status).toBe(502);
    await h.flush();
    expect(h.queue.sent).toHaveLength(0);
    expect(h.telemetry.accounting()).toEqual({ total: 3, allowed: 0, rejected: 3 });
  });
});

describe('privacy (NFR-5.2)', () => {
  it('neither the queued event nor any log line contains prompt or output text', async () => {
    const h = await priced();
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')));
    }
    h.queue.failures = 99;
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    await readAll(await handleProxyRequest(proxyRequest({ body: '{"stream":true,"messages":[{"content":"SECRET-PROMPT"}]}' }), h.deps, REQUEST_ID));
    await h.flush();
    h.queue.failures = 0;
    expect(JSON.stringify(h.telemetry.events)).not.toMatch(/SECRET/);
    expect(logs.join('\n')).not.toMatch(/SECRET/);
    expect(logs.join('\n')).not.toContain(PROVIDER_KEY);
  });
});

describe('end to end: request -> queue -> settlement -> next request (FR-2.3 / FR-2.4)', () => {
  const deliver = async (h: Harness, events: UsageEvent[]) => {
    const messages = events.map((e) => new FakeMessage(JSON.parse(JSON.stringify(e))));
    await handleUsageBatch(messages, settlementDeps(h));
    return messages;
  };

  it('settlement makes the spend visible, and the next request over budget is a 429 before the provider is contacted', async () => {
    const h = await priced();
    h.store.endUsers.set(`${TENANT_ID}:${USER_ID}`, { id: 'eu-1', budgetLimitUsd: 0.002, status: 'active' });
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    await readAll(await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID));
    await h.flush();

    // Not settled yet: eventually consistent, so the same user is still allowed (SRS 18: "Queue delay").
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    expect((await handleProxyRequest(proxyRequest(), h.deps, '88888888-8888-8888-8888-888888888888')).status).toBe(200);
    await h.flush();
    h.queue.sent.length = 1; // consider only the first request's event
    h.providerFetch.mockClear();

    const [message] = await deliver(h, h.queue.sent);
    expect(message!.acked).toBe(true);
    expect(Number(h.redis.data.get(spendKey(TENANT_ID, USER_ID)))).toBe(0.002);

    const blocked = await handleProxyRequest(proxyRequest(), h.deps, '77777777-7777-7777-7777-777777777777');
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('BUDGET_EXCEEDED');
    expect(h.providerFetch).not.toHaveBeenCalled();
  });

  it('duplicate queue delivery of the same event is counted once', async () => {
    const h = await priced();
    h.providerFetch.mockResolvedValue(sseResponse(OPENAI_CHUNKS));
    await readAll(await handleProxyRequest(proxyRequest(), h.deps, REQUEST_ID));
    await h.flush();
    await deliver(h, [h.queue.sent[0]!, h.queue.sent[0]!]); // at-least-once delivery
    await deliver(h, [h.queue.sent[0]!]); // and a later redelivery
    expect(Number(h.redis.data.get(spendKey(TENANT_ID, USER_ID)))).toBe(0.002);
    expect(h.usageStore.logs.size).toBe(1);
    expect([...h.usageStore.spend.values()]).toEqual([0.002]);
  });
});

describe('Worker queue() entry point', () => {
  const env = {
    UPSTASH_REDIS_REST_URL: 'https://r.test', UPSTASH_REDIS_REST_TOKEN: 't',
    SUPABASE_URL: 'https://d.test', SUPABASE_SERVICE_ROLE_KEY: 's', CREDENTIAL_ENCRYPTION_KEY: 'k',
    USAGE_QUEUE: { send: async () => {} } as never,
  };
  const event: UsageEvent = {
    requestId: REQUEST_ID, tenantId: TENANT_ID, externalUserId: USER_ID, provider: 'openai', model: 'm', statusCode: 200,
    inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCostUsd: 0.5, usageSource: 'provider_reported',
    latencyMs: 5, streaming: true, occurredAt: '2026-09-26T10:00:00.000Z',
  };

  it('settles through Upstash (EVAL) and the settle_usage RPC, then acks', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as unknown;
      calls.push({ url, body });
      return url.startsWith('https://r.test')
        ? new Response(JSON.stringify({ result: 1 }))
        : new Response('true', { headers: { 'content-type': 'application/json' } });
    });
    const message = new FakeMessage(event);
    await worker.queue!({ messages: [message] } as never, env as never);
    expect(message.acked).toBe(true);
    const redisBody = calls[0]!.body as unknown[];
    expect(redisBody[0]).toBe('EVAL');
    expect(redisBody.slice(2)).toEqual([2, spendKey(TENANT_ID, USER_ID), `settled:${REQUEST_ID}`, '0.50000000', expect.any(Number)]);
    expect(calls[1]!.url).toBe('https://d.test/rest/v1/rpc/settle_usage');
    expect(calls[1]!.body).toMatchObject({ p_request_id: REQUEST_ID, p_tenant_id: TENANT_ID, p_external_user_id: USER_ID, p_estimated_cost_usd: 0.5 });
    vi.unstubAllGlobals();
  });

  it('retries the message when Redis or the database is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('down', { status: 500 }));
    const message = new FakeMessage(event, 2);
    await worker.queue!({ messages: [message] } as never, env as never);
    expect(message.acked).toBe(false);
    expect(message.retried).toEqual({ delaySeconds: 30 });
    vi.unstubAllGlobals();
  });

  it('a missing binding/secret throws so the whole batch is redelivered, never lost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = new FakeMessage(event);
    await expect(worker.queue!({ messages: [message] } as never, {} as never)).rejects.toThrow();
    expect(message.acked).toBe(false);
  });

  it('fetch() reports 503 on /health when the queue binding is missing (it is required)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const withoutQueue = { ...env, USAGE_QUEUE: undefined };
    const res = await worker.fetch(new Request('https://zeropoint.example/health'), withoutQueue as never, { waitUntil() {} } as never);
    expect(res.status).toBe(503);
  });
});
