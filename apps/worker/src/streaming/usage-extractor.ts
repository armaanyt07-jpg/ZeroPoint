import { calculateCostUsd, findPricing } from '@zeropoint/pricing';
import { SseParser, mayContainUsage, mergeUsage } from '@zeropoint/providers';
import type { LLMProviderAdapter } from '@zeropoint/providers';
import type { ModelPricing, PartialUsage, UsageEvent, UsageSource } from '@zeropoint/types';
import type { Telemetry } from '../telemetry';
import { dispatchUsageEvent, type RetryOptions, type UsageQueue } from '../usage-queue';

/**
 * Non-streaming (JSON) responses must be parsed as a whole, so Branch B buffers
 * them, but only up to this many bytes. Larger bodies are still drained, just not
 * inspected: usage is then reported as unknown rather than growing memory (SRS 2.3).
 */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

/** Everything the analytics branch needs to know about the request it belongs to. */
export interface UsageContext {
  requestId: string;
  tenantId: string;
  externalUserId: string;
  /** `Date.now()` when the Worker started handling the request (for latency_ms). */
  startedAt: number;
  queue: UsageQueue;
  /** `ctx.waitUntil`: keeps the Worker alive to finish Branch B after the response is returned. */
  defer: (work: Promise<unknown>) => void;
  /** Overrides queue retry timing (tests). */
  queueRetry?: Partial<RetryOptions>;
  /**
   * The administrator-entered price table (Phase 4, D9). Awaited only when a
   * request actually has usage to price, and called again once if that fails.
   * The pipeline passes a `prefetchPrices` loader, so the first call usually
   * returns a read started before the provider was called (D18).
   * Absent = only the adapter's static table.
   */
  loadPrices?: () => Promise<readonly ModelPricing[]>;
}

export interface UsageResponseInfo {
  provider: string;
  statusCode: number;
  contentType: string;
  /** Path of the client's request; Gemini's model name is in it. */
  pathname: string;
}

export interface ReadResult {
  usage: PartialUsage;
  /** True if the body was too large to inspect or an SSE frame had to be dropped. */
  incomplete: boolean;
}

/**
 * FR-2.2. Reads Stream B chunk by chunk, decodes it incrementally and merges the
 * usage the adapter finds. Text is never accumulated: only numbers and the model
 * name are kept (NFR-5.2). Runs to the end of the stream even if the client has
 * disconnected, so usage the provider reports last is still captured.
 * Never throws: a broken upstream stream just ends the read.
 */
export async function readUsageFromSse(
  stream: ReadableStream<Uint8Array>,
  adapter: LLMProviderAdapter,
): Promise<ReadResult> {
  const parser = new SseParser();
  const usage: PartialUsage = {};
  const handle = (events: ReturnType<SseParser['push']>) => {
    for (const event of events) {
      if (event.data === '[DONE]' || !mayContainUsage(event)) continue; // NFR-5.1: skip needless JSON.parse
      try {
        mergeUsage(usage, adapter.extractUsage(JSON.parse(event.data) as unknown));
      } catch {
        // A frame that isn't JSON carries no usage.
      }
    }
  };
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle(parser.push(value));
    }
  } catch {
    // Upstream stream aborted: settle with whatever was seen.
  }
  handle(parser.end());
  return { usage, incomplete: parser.overflowed };
}

/** Non-streaming responses (D1): buffer up to `MAX_JSON_BODY_BYTES`, then parse once. */
export async function readUsageFromJson(
  stream: ReadableStream<Uint8Array>,
  adapter: LLMProviderAdapter,
): Promise<ReadResult> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let incomplete = false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (incomplete) continue; // keep draining, stop storing
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        incomplete = true;
        chunks.length = 0;
      } else {
        chunks.push(value);
      }
    }
  } catch {
    incomplete = true;
  }
  if (incomplete) return { usage: {}, incomplete };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const usage = adapter.extractUsage(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    return { usage: usage ?? {}, incomplete: false };
  } catch {
    return { usage: {}, incomplete: true };
  }
}

/** The model a usage report belongs to: what the provider said, else (Gemini) the URL. */
const resolveModel = (adapter: LLMProviderAdapter, info: UsageResponseInfo, usage: PartialUsage) =>
  usage.model ?? adapter.modelFromPath?.(info.pathname) ?? null;

/** Pricing needs both token counts and a model; anything less is never priced. */
const isPriceable = (adapter: LLMProviderAdapter, info: UsageResponseInfo, usage: PartialUsage) =>
  usage.inputTokens !== undefined && usage.outputTokens !== undefined && resolveModel(adapter, info, usage) !== null;

/**
 * Normalizes what was found into the queue message (SRS section 9).
 *
 * `usage_source`: 'provider_reported' only when the provider reported both token
 * counts AND the model has a price. Otherwise 'unknown' and cost 0 (D3): the
 * SRS defines no price values and no token estimator, so nothing is guessed.
 * Token counts that WERE reported are still stored.
 *
 * Prices: the administrator-entered table (`prices`, Phase 4 D9) wins; the
 * adapter's static table is the fallback. The cost is fixed here, in the event,
 * so a queue retry after a price edit can never charge Redis and Postgres differently.
 */
export function buildUsageEvent(
  adapter: LLMProviderAdapter,
  ctx: UsageContext,
  info: UsageResponseInfo,
  usage: PartialUsage,
  streaming: boolean,
  now = Date.now(),
  prices: readonly ModelPricing[] = [],
): UsageEvent {
  const model = resolveModel(adapter, info, usage);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  let estimatedCostUsd = 0;
  let usageSource: UsageSource = 'unknown';
  if (model !== null && isPriceable(adapter, info, usage)) {
    try {
      const price = findPricing(prices, adapter.id, model);
      estimatedCostUsd = price
        ? calculateCostUsd({ inputTokens, outputTokens }, price)
        : adapter.calculateCost({ model, inputTokens, outputTokens });
      usageSource = 'provider_reported';
    } catch {
      // No price for this model: cost stays 0 and the source stays 'unknown'.
    }
  }
  return {
    requestId: ctx.requestId,
    tenantId: ctx.tenantId,
    externalUserId: ctx.externalUserId,
    provider: adapter.id,
    model,
    statusCode: info.statusCode,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd,
    usageSource,
    latencyMs: Math.max(0, Math.round(now - ctx.startedAt)),
    streaming,
    occurredAt: new Date(ctx.startedAt).toISOString(),
  };
}

/**
 * The whole analytics branch (FR-2.1 Stream B): read -> extract -> usage event ->
 * queue. Runs under `ctx.waitUntil`. It must never throw or affect Stream A.
 */
export async function trackUsage(
  stream: ReadableStream<Uint8Array> | null,
  adapter: LLMProviderAdapter,
  ctx: UsageContext,
  info: UsageResponseInfo,
  telemetry: Telemetry,
): Promise<void> {
  try {
    const streaming = info.contentType.toLowerCase().includes('text/event-stream');
    if (streaming) telemetry.increment('streaming_requests', { provider: adapter.id });
    const { usage, incomplete } = stream
      ? streaming
        ? await readUsageFromSse(stream, adapter)
        : await readUsageFromJson(stream, adapter)
      : { usage: {}, incomplete: false };

    const prices = isPriceable(adapter, info, usage) ? await loadPrices(ctx) : [];
    const event = buildUsageEvent(adapter, ctx, info, usage, streaming, Date.now(), prices);
    telemetry.increment('token_usage', { provider: adapter.id, usage_source: event.usageSource }, event.totalTokens);
    telemetry.increment('estimated_spend', { provider: adapter.id }, event.estimatedCostUsd);
    if (incomplete) {
      console.warn(JSON.stringify({ type: 'usage_incomplete', request_id: ctx.requestId, provider: adapter.id }));
    }
    await dispatchUsageEvent(ctx.queue, event, telemetry, ctx.queueRetry);
  } catch (error) {
    // Log only the error type: messages could in theory echo stream content.
    console.error(
      JSON.stringify({ type: 'usage_branch_error', request_id: ctx.requestId, name: (error as Error)?.name }),
    );
  }
}

/** The first price-table read plus one retry (D18). */
export const PRICE_LOAD_ATTEMPTS = 2;

/**
 * Starts `load` right away and returns a loader: its first call gets that early
 * result, any later call (a retry) loads again.
 *
 * Why (D18): an LLM answer can take a minute. A price lookup made only after
 * that wait was seen to time out in practice, and a request that can't be priced
 * is recorded at cost 0, so it never counts against the user's budget. Starting
 * the read while the provider is still answering avoids the wait. The read is
 * usually one Redis GET (`cache:pricing`) and is not awaited before forwarding,
 * so it adds no latency.
 */
export function prefetchPrices(
  load: () => Promise<readonly ModelPricing[]>,
): () => Promise<readonly ModelPricing[]> {
  let early: Promise<readonly ModelPricing[]> | undefined = load();
  early.catch(() => {}); // the first caller sees the error; avoid an unhandled rejection until then
  return () => {
    const result = early ?? load();
    early = undefined;
    return result;
  };
}

/**
 * A failed read is retried once. If both attempts fail, the request is recorded
 * as "unpriced" (cost 0, usage_source 'unknown') rather than dropped: losing the
 * event would lose its token counts too, and the request log still shows the
 * model is missing a cost.
 */
async function loadPrices(ctx: UsageContext): Promise<readonly ModelPricing[]> {
  if (!ctx.loadPrices) return [];
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.loadPrices();
    } catch (error) {
      console.error(
        JSON.stringify({
          type: 'price_lookup_failed',
          request_id: ctx.requestId,
          attempt,
          name: (error as Error)?.name,
        }),
      );
      if (attempt >= PRICE_LOAD_ATTEMPTS) return [];
    }
  }
}
