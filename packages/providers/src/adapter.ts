import type { PartialUsage, ProviderId, ProviderUsage } from '@zeropoint/types';

/**
 * The contract every LLM provider integration implements (SRS NFR-5.6).
 *
 * Deviations from the SRS signature (documented in docs/PHASE_1.md):
 * - `buildProviderRequest` takes the provider API key as a second argument,
 *   because FR-1.3 requires swapping the proxy credential for the provider
 *   credential and the SRS signature gave the adapter no way to receive it.
 * - `matchesPath` lets the router recognise each provider's URL shape.
 * - Phase 2: SSE decoding is provider-agnostic and lives in `SseParser` (a frame
 *   can span chunks, which a stateless chunk-in/usage-out method cannot handle),
 *   so the adapter's real job is `extractUsage`: turn one decoded JSON payload
 *   into normalized usage. `parseStreamChunk` remains as a one-shot convenience.
 */
export interface LLMProviderAdapter {
  readonly id: ProviderId;

  /** Does this provider serve this URL path? Used for routing before any auth work. */
  matchesPath(pathname: string): boolean;

  /**
   * Is this inbound request one this adapter can serve (POST, a path it owns, a
   * Bearer credential present)? This is NOT proxy-key validation; that lives in
   * apps/worker/src/auth.ts.
   */
  authenticate(request: Request): Promise<boolean>;

  /** Builds the upstream request: provider URL, allow-listed headers, provider credential. */
  buildProviderRequest(request: Request, providerApiKey: string): Promise<Request>;

  /**
   * One-shot: usage from a self-contained chunk of SSE text (SRS signature).
   * The proxy itself uses `SseParser` + `extractUsage` so frames may span chunks.
   */
  parseStreamChunk(chunk: Uint8Array): ProviderUsage | null;

  /**
   * Usage revealed by ONE parsed JSON payload: a streamed SSE event's `data`, or
   * a complete non-streaming response body. Returns null when it says nothing
   * about usage. Never throws on unexpected shapes.
   */
  extractUsage(payload: unknown): PartialUsage | null;

  /** Fallback model name from the request path (Gemini puts it in the URL). */
  modelFromPath?(pathname: string): string | null;

  /** Cost in USD for normalized usage, using this adapter's pricing table. */
  calculateCost(usage: ProviderUsage): number;
}
