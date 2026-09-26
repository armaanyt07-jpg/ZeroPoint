import { calculateCostUsd, findPricing } from '@zeropoint/pricing';
import type { ModelPricing, ProviderUsage } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';

const UPSTREAM_URL = 'https://api.openai.com/v1/chat/completions';
const SUPPORTED_PATH = '/v1/chat/completions';

/**
 * Only these client headers are passed upstream. An allow-list is safer than a
 * block-list: anything unexpected (proxy key, x-user-id, cookies, cf-* headers)
 * is dropped by default.
 */
const FORWARDED_HEADERS = [
  'content-type',
  'accept',
  'openai-organization',
  'openai-project',
  'openai-beta',
];

export class OpenAIAdapter implements LLMProviderAdapter {
  readonly id = 'openai';

  /** Pricing is injected; Phase 1 ships no price table (Phase 2 adds it). */
  constructor(private readonly pricing: readonly ModelPricing[] = []) {}

  async authenticate(request: Request): Promise<boolean> {
    if (request.method !== 'POST') return false;
    if (new URL(request.url).pathname !== SUPPORTED_PATH) return false;
    return /^Bearer\s+\S+/i.test(request.headers.get('authorization') ?? '');
  }

  async buildProviderRequest(request: Request, providerApiKey: string): Promise<Request> {
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    // FR-1.3: the proxy credential is replaced, never forwarded.
    headers.set('authorization', `Bearer ${providerApiKey}`);

    // The body is passed as a stream, so large prompts are never buffered in memory.
    // `duplex: 'half'` is required by the fetch spec when streaming a request body.
    return new Request(UPSTREAM_URL, {
      method: 'POST',
      headers,
      body: request.body,
      duplex: 'half',
    } as RequestInit);
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
