import { calculateCostUsd, findPricing } from '@zeropoint/pricing';
import type { ModelPricing, ProviderUsage } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';
import { copyAllowedHeaders, isPostWithBearer, streamingPost } from './shared';

const UPSTREAM_URL = 'https://api.anthropic.com/v1/messages';
const SUPPORTED_PATH = '/v1/messages';
const DEFAULT_API_VERSION = '2023-06-01';

const FORWARDED_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'];

/**
 * Anthropic differs from OpenAI in two ways this adapter hides from the proxy:
 * the key goes in an `x-api-key` header (not `Authorization: Bearer`), and every
 * request needs an `anthropic-version` header.
 *
 * Clients still authenticate to ZeroPoint with `Authorization: Bearer <proxy key>` (FR-1.1).
 */
export class AnthropicAdapter implements LLMProviderAdapter {
  readonly id = 'anthropic';

  constructor(private readonly pricing: readonly ModelPricing[] = []) {}

  matchesPath(pathname: string): boolean {
    return pathname === SUPPORTED_PATH;
  }

  async authenticate(request: Request): Promise<boolean> {
    return isPostWithBearer(request) && this.matchesPath(new URL(request.url).pathname);
  }

  async buildProviderRequest(request: Request, providerApiKey: string): Promise<Request> {
    const headers = copyAllowedHeaders(request, FORWARDED_HEADERS);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', DEFAULT_API_VERSION);
    // FR-1.3: no Authorization header goes upstream at all, so the proxy key cannot leak.
    headers.set('x-api-key', providerApiKey);
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
