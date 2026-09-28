import { calculateCostUsd, findPricing } from '@zeropoint/pricing';
import type { ModelPricing, PartialUsage, ProviderUsage } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';
import { copyAllowedHeaders, isPostWithBearer, streamingPost, withStreamUsageOptIn } from './shared';
import { asRecord, parseChunkOnce, stringOrUndefined, tokenCount } from './usage';

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

  /** Pricing is injected (see packages/pricing: the SRS specifies no price values). */
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
    return streamingPost(UPSTREAM_URL, headers, await withStreamUsageOptIn(request.body));
  }

  parseStreamChunk(chunk: Uint8Array): ProviderUsage | null {
    return parseChunkOnce(this, chunk);
  }

  /**
   * Chat Completions: every streamed chunk has `model` and `usage: null`; with
   * `include_usage` the final chunk has `usage: { prompt_tokens, completion_tokens }`.
   * A non-streaming body has the same top-level shape. (Cached/reasoning token
   * breakdowns are not priced separately: the SRS has one input and one output price.)
   */
  extractUsage(payload: unknown): PartialUsage | null {
    const body = asRecord(payload);
    if (!body) return null;
    const usage = asRecord(body['usage']);
    const result: PartialUsage = {};
    const model = stringOrUndefined(body['model']);
    if (model !== undefined) result.model = model;
    const input = tokenCount(usage?.['prompt_tokens']);
    const output = tokenCount(usage?.['completion_tokens']);
    if (input !== undefined) result.inputTokens = input;
    if (output !== undefined) result.outputTokens = output;
    return Object.keys(result).length > 0 ? result : null;
  }

  calculateCost(usage: ProviderUsage): number {
    const pricing = findPricing(this.pricing, this.id, usage.model);
    if (!pricing) throw new Error(`No pricing configured for ${this.id}/${usage.model}.`);
    return calculateCostUsd(usage, pricing);
  }
}
