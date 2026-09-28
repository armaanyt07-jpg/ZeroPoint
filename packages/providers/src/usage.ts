import type { PartialUsage, ProviderUsage, SseEvent } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';
import { SseParser } from './sse-parser';

/** Narrowing helpers for untrusted provider JSON. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A usable token count: a finite, non-negative number (floored). Anything else is "not reported". */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Providers report CUMULATIVE totals, so within one response the latest value
 * of each field wins; a later event that omits a field never erases it.
 */
export function mergeUsage(into: PartialUsage, next: PartialUsage | null): PartialUsage {
  if (!next) return into;
  if (next.model !== undefined) into.model = next.model;
  if (next.inputTokens !== undefined) into.inputTokens = next.inputTokens;
  if (next.outputTokens !== undefined) into.outputTokens = next.outputTokens;
  return into;
}

/** Used only to skip JSON.parse on frames that cannot carry usage (NFR-5.1). */
export function mayContainUsage(event: SseEvent): boolean {
  return event.data.includes('"usage');
}

/**
 * Stateless one-shot implementation of the SRS `parseStreamChunk` signature:
 * treats `chunk` as a self-contained piece of an SSE stream. The real streaming
 * path keeps one `SseParser` per response (so frames split across chunks work);
 * this exists so the SRS interface remains meaningful for a complete chunk.
 */
export function parseChunkOnce(adapter: LLMProviderAdapter, chunk: Uint8Array): ProviderUsage | null {
  const parser = new SseParser();
  const events = [...parser.push(chunk), ...parser.end()];
  const usage: PartialUsage = {};
  for (const event of events) {
    if (event.data === '[DONE]' || !mayContainUsage(event)) continue;
    try {
      mergeUsage(usage, adapter.extractUsage(JSON.parse(event.data) as unknown));
    } catch {
      // not JSON: ignore
    }
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
  return {
    model: usage.model ?? '',
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}
