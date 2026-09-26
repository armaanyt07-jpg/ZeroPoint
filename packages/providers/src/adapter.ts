import type { ProviderId, ProviderUsage } from '@zeropoint/types';

/**
 * The contract every LLM provider integration implements (SRS NFR-5.6).
 *
 * Deviation from the SRS signature: `buildProviderRequest` takes the provider
 * API key as a second argument, because FR-1.3 requires swapping the proxy
 * credential for the provider credential and the SRS signature gave the
 * adapter no way to receive it.
 */
export interface LLMProviderAdapter {
  readonly id: ProviderId;

  /**
   * Is this inbound request one this adapter can serve (right method/path and a
   * Bearer credential present)? This is NOT proxy-key validation; that lives in
   * apps/worker/src/auth.ts.
   */
  authenticate(request: Request): Promise<boolean>;

  /** Builds the upstream request: provider URL, allow-listed headers, provider credential. */
  buildProviderRequest(request: Request, providerApiKey: string): Promise<Request>;

  /** PHASE 2: incrementally extract usage from an SSE chunk. Phase 1 always returns null. */
  parseStreamChunk(chunk: Uint8Array): ProviderUsage | null;

  /** Cost in USD for normalized usage, using this adapter's pricing table. */
  calculateCost(usage: ProviderUsage): number;
}
