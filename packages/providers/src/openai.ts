import { calculateCostUsd, findPricing } from '@zeropoint/pricing';
import type { ModelPricing, ProviderUsage } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';
import { copyAllowedHeaders, isPostWithBearer, streamingPost } from './shared';

const UPSTREAM_URL = 'https://api.openai.com/v1/chat/completions';
const SUPPORTED_PATH = '/v1/chat/completions';

/**
 * `openai-organization` and `openai-project` are deliberately NOT forwarded: they
 * decide which OpenAI org/project is billed, and that must not be steerable by
 * whoever holds a proxy key. Requests use the provider key's default org/project.
 * (Configuring these per tenant is deferred; see docs/PHASE_1.md.)
 */
const FORWARDED_HEADERS = ['content-type', 'accept', 'openai-beta'];

export class OpenAIAdapter implements LLMProviderAdapter {
  readonly id = 'openai';

  /** Pricing is injected; Phase 1 ships no price table (Phase 2 adds it). */
  constructor(private readonly pricing: readonly ModelPricing[] = []) {}

  matchesPath(pathname: string): boolean {
    return pathname === SUPPORTED_PATH;
  }

  async authenticate(request: Request): Promise<boolean> {
    return isPostWithBearer(request) && this.matchesPath(new URL(request.url).pathname);
  }

  async buildProviderRequest(request: Request, providerApiKey: string): Promise<Request> {
    const headers = copyAllowedHeaders(request, FORWARDED_HEADERS);
    // FR-1.3: the proxy credential is replaced, never forwarded.
    headers.set('authorization', `Bearer ${providerApiKey}`);
    return streamingPost(UPSTREAM_URL, headers, request.body);
  }

  /** PHASE 2 STUB: SSE usage extraction is implemented with dual-stream parsing (FR-2.2). */
  parseStreamChunk(_chunk: Uint8Array): ProviderUsage | null {
    return null;
  }

  calculateCost(usage: ProviderUsage): number {
    const pricing = findPricing(this.pricing, this.id, usage.model);
    if (!pricing) throw new Error(`No pricing configured for ${this.id}/${usage.model}.`);
    return calculateCostUsd(usage, pricing);
  }
}
