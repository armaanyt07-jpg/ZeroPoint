import { DEFAULT_PRICING, PRICING_VERSION, calculateCostUsd } from '@zeropoint/pricing';
import {
  AnthropicAdapter,
  GeminiAdapter,
  OpenAIAdapter,
  createDefaultRegistry,
  mergeUsage,
  type LLMProviderAdapter,
} from '@zeropoint/providers';
import type { ModelPricing, PartialUsage } from '@zeropoint/types';
import { describe, expect, it } from 'vitest';
import { buildUsageEvent, readUsageFromJson, readUsageFromSse, MAX_JSON_BODY_BYTES, type UsageContext } from '../../apps/worker/src/streaming/usage-extractor';
import { FakeUsageQueue } from '../helpers';

const enc = new TextEncoder();
const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/** Test-only prices so the cost path can be exercised. NOT real prices, NOT shipped. */
const FIXTURE_PRICING: ModelPricing[] = [
  { provider: 'openai', model: 'fixture-model', inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
  { provider: 'anthropic', model: 'fixture-model', inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
  { provider: 'gemini', model: 'fixture-model', inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
];

// ---- provider-specific stream fixtures ------------------------------------------------

const OPENAI_SSE =
  'data: {"id":"c1","model":"fixture-model","choices":[{"delta":{"content":"SECRET hello"}}],"usage":null}\n\n' +
  'data: {"id":"c1","model":"fixture-model","choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' +
  'data: {"id":"c1","model":"fixture-model","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}\n\n' +
  'data: [DONE]\n\n';

const ANTHROPIC_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"fixture-model","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n' +
  'event: ping\ndata: {"type":"ping"}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"SECRET hello"}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":500}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const GEMINI_SSE =
  'data: {"candidates":[{"content":{"parts":[{"text":"SECRET hello"}]}}],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":100},"modelVersion":"fixture-model"}\r\n\r\n' +
  'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":400,"thoughtsTokenCount":100,"totalTokenCount":1500},"modelVersion":"fixture-model"}\r\n\r\n';

const CASES: [string, LLMProviderAdapter, string][] = [
  ['openai', new OpenAIAdapter(FIXTURE_PRICING), OPENAI_SSE],
  ['anthropic', new AnthropicAdapter(FIXTURE_PRICING), ANTHROPIC_SSE],
  ['gemini', new GeminiAdapter(FIXTURE_PRICING), GEMINI_SSE],
];
const EXPECTED_USAGE: PartialUsage = { model: 'fixture-model', inputTokens: 1000, outputTokens: 500 };

describe('provider-specific streaming formats: usage survives arbitrary chunk boundaries', () => {
  it.each(CASES)('%s: same usage from one chunk, every 2-way split, and byte-by-byte', async (_id, adapter, sse) => {
    const bytes = enc.encode(sse);
    expect((await readUsageFromSse(streamOf([bytes]), adapter)).usage).toEqual(EXPECTED_USAGE);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const { usage } = await readUsageFromSse(streamOf([bytes.slice(0, cut), bytes.slice(cut)]), adapter);
      expect(usage, `${_id} cut ${cut}`).toEqual(EXPECTED_USAGE);
    }
    const single = await readUsageFromSse(streamOf(Array.from(bytes, (b) => Uint8Array.of(b))), adapter);
    expect(single.usage).toEqual(EXPECTED_USAGE);
  });

  it.each(CASES)('%s: a stream with no usage frames yields no token counts', async (_id, adapter) => {
    const { usage } = await readUsageFromSse(streamOf([enc.encode('data: {"choices":[]}\n\ndata: [DONE]\n\n')]), adapter);
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
  });

  it('keeps what was seen when the upstream stream errors part-way', async () => {
    const half = enc.encode(ANTHROPIC_SSE.slice(0, ANTHROPIC_SSE.indexOf('event: message_delta')));
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(half);
        } else {
          controller.error(new Error('upstream reset'));
        }
      },
    });
    const { usage } = await readUsageFromSse(broken, new AnthropicAdapter());
    expect(usage).toEqual({ model: 'fixture-model', inputTokens: 1000, outputTokens: 1 });
  });

  it('ignores [DONE] and frames that are not JSON', async () => {
    const { usage } = await readUsageFromSse(
      streamOf([enc.encode('data: "usage" but not json\n\ndata: [DONE]\n\n')]),
      new OpenAIAdapter(),
    );
    expect(usage).toEqual({});
  });
});

describe('OpenAI extractUsage', () => {
  const a = new OpenAIAdapter();
  it('reads prompt/completion tokens and model; null when usage is null', () => {
    expect(a.extractUsage({ model: 'm', usage: { prompt_tokens: 3, completion_tokens: 4 } })).toEqual({
      model: 'm', inputTokens: 3, outputTokens: 4,
    });
    expect(a.extractUsage({ model: 'm', usage: null })).toEqual({ model: 'm' });
  });
  it.each([undefined, null, 'x', 5, [], {}, { usage: { prompt_tokens: -1, completion_tokens: 'a' } }])(
    'never throws on junk (%j)',
    (junk) => {
      expect(() => a.extractUsage(junk)).not.toThrow();
    },
  );
  it('rejects negative, NaN and non-numeric counts instead of trusting them', () => {
    expect(a.extractUsage({ usage: { prompt_tokens: -5, completion_tokens: Number.NaN } })).toBeNull();
    expect(a.extractUsage({ usage: { prompt_tokens: '7', completion_tokens: 1 } })).toEqual({ outputTokens: 1 });
  });
});

describe('Anthropic extractUsage', () => {
  const a = new AnthropicAdapter();
  it('message_start gives model + input tokens; message_delta gives output tokens', () => {
    expect(a.extractUsage({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 9, output_tokens: 1 } } })).toEqual({
      model: 'm', inputTokens: 9, outputTokens: 1,
    });
    expect(a.extractUsage({ type: 'message_delta', usage: { output_tokens: 42 } })).toEqual({ outputTokens: 42 });
  });
  it('a non-streaming body has top-level model and usage', () => {
    expect(a.extractUsage({ model: 'm', usage: { input_tokens: 5, output_tokens: 6 } })).toEqual({
      model: 'm', inputTokens: 5, outputTokens: 6,
    });
  });
  it('ping, content deltas and error events carry no usage', () => {
    expect(a.extractUsage({ type: 'ping' })).toBeNull();
    expect(a.extractUsage({ type: 'error', error: { type: 'overloaded_error', message: 'x' } })).toBeNull();
  });
});

describe('Gemini extractUsage', () => {
  const a = new GeminiAdapter();
  it('counts thinking tokens as output; missing candidates means 0 output', () => {
    expect(a.extractUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 }, modelVersion: 'g' })).toEqual({
      model: 'g', inputTokens: 10, outputTokens: 8,
    });
    expect(a.extractUsage({ usageMetadata: { promptTokenCount: 10 } })).toEqual({ inputTokens: 10, outputTokens: 0 });
  });
  it('merges a JSON array (streamGenerateContent without alt=sse); the last cumulative value wins', () => {
    expect(
      a.extractUsage([
        { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } },
        { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 9 }, modelVersion: 'g' },
      ]),
    ).toEqual({ model: 'g', inputTokens: 10, outputTokens: 9 });
  });
  it('takes the model from the URL path when the body has none', () => {
    expect(a.modelFromPath('/v1beta/models/gemini-2.0-flash:streamGenerateContent')).toBe('gemini-2.0-flash');
    expect(a.modelFromPath('/v1/chat/completions')).toBeNull();
  });
});

describe('parseStreamChunk (SRS interface, one-shot)', () => {
  it.each(CASES)('%s: returns normalized usage from a complete chunk', (_id, adapter, sse) => {
    expect(adapter.parseStreamChunk(enc.encode(sse))).toEqual({ model: 'fixture-model', inputTokens: 1000, outputTokens: 500 });
  });
  it('returns null when the chunk has no usage', () => {
    for (const [, adapter] of CASES) expect(adapter.parseStreamChunk(enc.encode('data: {"x":1}\n\n'))).toBeNull();
  });
});

describe('mergeUsage', () => {
  it('latest value wins per field and a later event that omits a field never erases it', () => {
    const acc: PartialUsage = {};
    mergeUsage(acc, { model: 'm', inputTokens: 5, outputTokens: 1 });
    mergeUsage(acc, { outputTokens: 9 });
    mergeUsage(acc, null);
    expect(acc).toEqual({ model: 'm', inputTokens: 5, outputTokens: 9 });
  });
});

describe('non-streaming JSON responses (D1)', () => {
  it('parses usage from the complete body', async () => {
    const body = JSON.stringify({ model: 'fixture-model', usage: { prompt_tokens: 1000, completion_tokens: 500 } });
    const { usage, incomplete } = await readUsageFromJson(streamOf([enc.encode(body.slice(0, 20)), enc.encode(body.slice(20))]), new OpenAIAdapter());
    expect(usage).toEqual(EXPECTED_USAGE);
    expect(incomplete).toBe(false);
  });
  it('bounds memory: a body over the cap is drained but not inspected (usage unknown)', async () => {
    const big = new Uint8Array(MAX_JSON_BODY_BYTES + 1);
    const { usage, incomplete } = await readUsageFromJson(streamOf([big]), new OpenAIAdapter());
    expect(usage).toEqual({});
    expect(incomplete).toBe(true);
  });
  it('a body that is not JSON is unknown, not an error', async () => {
    expect((await readUsageFromJson(streamOf([enc.encode('nope')]), new OpenAIAdapter())).incomplete).toBe(true);
  });
});

describe('buildUsageEvent / cost (SRS section 9)', () => {
  const ctx: UsageContext = {
    requestId: '22222222-2222-2222-2222-222222222222',
    tenantId: '11111111-1111-1111-1111-111111111111',
    externalUserId: 'user_1',
    startedAt: 1_000,
    queue: new FakeUsageQueue(),
    defer: () => {},
  };
  const info = { provider: 'openai', statusCode: 200, contentType: 'text/event-stream', pathname: '/v1/chat/completions' };

  it('priced model: provider_reported and cost = in x price + out x price', () => {
    const event = buildUsageEvent(new OpenAIAdapter(FIXTURE_PRICING), ctx, info, EXPECTED_USAGE, true, 1_250);
    expect(event).toMatchObject({
      requestId: ctx.requestId, tenantId: ctx.tenantId, externalUserId: 'user_1', provider: 'openai',
      model: 'fixture-model', statusCode: 200, inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
      usageSource: 'provider_reported', latencyMs: 250, streaming: true,
    });
    expect(event.estimatedCostUsd).toBe(0.002); // 1000 x $1/M + 500 x $2/M
    expect(event.occurredAt).toBe(new Date(1_000).toISOString());
  });

  it('unpriced model (D3): tokens are kept, cost is 0 and usage_source is unknown', () => {
    const event = buildUsageEvent(new OpenAIAdapter([]), ctx, info, EXPECTED_USAGE, true);
    expect(event).toMatchObject({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, estimatedCostUsd: 0, usageSource: 'unknown' });
  });

  it('no usage reported: zero tokens, cost 0, unknown', () => {
    const event = buildUsageEvent(new OpenAIAdapter(FIXTURE_PRICING), ctx, info, {}, true);
    expect(event).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, usageSource: 'unknown', model: null });
  });

  it('only one of the two counts reported is not enough to price', () => {
    const event = buildUsageEvent(new OpenAIAdapter(FIXTURE_PRICING), ctx, info, { model: 'fixture-model', inputTokens: 10 }, true);
    expect(event.usageSource).toBe('unknown');
    expect(event.estimatedCostUsd).toBe(0);
  });

  it('Gemini falls back to the model in the URL', () => {
    const event = buildUsageEvent(
      new GeminiAdapter(FIXTURE_PRICING),
      ctx,
      { ...info, provider: 'gemini', pathname: '/v1beta/models/fixture-model:generateContent' },
      { inputTokens: 1, outputTokens: 1 },
      false,
    );
    expect(event.model).toBe('fixture-model');
    expect(event.usageSource).toBe('provider_reported');
  });

  it('the event has only metadata fields: no prompt or output text (NFR-5.2)', async () => {
    const { usage } = await readUsageFromSse(streamOf([enc.encode(OPENAI_SSE)]), new OpenAIAdapter(FIXTURE_PRICING));
    const event = buildUsageEvent(new OpenAIAdapter(FIXTURE_PRICING), ctx, info, usage, true);
    expect(JSON.stringify(event)).not.toContain('SECRET');
    expect(Object.keys(event).sort()).toEqual([
      'estimatedCostUsd', 'externalUserId', 'inputTokens', 'latencyMs', 'model', 'occurredAt', 'outputTokens',
      'provider', 'requestId', 'statusCode', 'streaming', 'tenantId', 'totalTokens', 'usageSource',
    ]);
  });
});

describe('pricing configuration (D3)', () => {
  it('ships NO price values: the SRS specifies none, so none are invented', () => {
    expect(DEFAULT_PRICING).toEqual([]);
    expect(PRICING_VERSION).toBeTruthy();
  });
  it('the default registry therefore treats every model as unpriced', () => {
    const openai = createDefaultRegistry().get('openai')!;
    expect(() => openai.calculateCost({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 })).toThrow(/No pricing/);
  });
  it('rounds cost to the ledger precision (8 decimals)', () => {
    const cost = calculateCostUsd({ inputTokens: 1, outputTokens: 0 }, { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0 });
    expect(cost).toBe(1e-7);
    expect(calculateCostUsd({ inputTokens: 3, outputTokens: 0 }, { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0 })).toBe(3e-7);
  });
});
