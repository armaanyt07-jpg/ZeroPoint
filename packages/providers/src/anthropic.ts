import { calculateCostUsd, findPricing } from '@zeropoint/pricing';
import type { ModelPricing, PartialUsage, ProviderUsage } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';
import { copyAllowedHeaders, isPostWithBearer, streamingPost } from './shared';
import { asRecord, parseChunkOnce, stringOrUndefined, tokenCount } from './usage';

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

  parseStreamChunk(chunk: Uint8Array): ProviderUsage | null {
    return parseChunkOnce(this, chunk);
  }

  /**
   * Streaming: `message_start` carries `message.model` and `message.usage.input_tokens`;
   * `message_delta` carries the cumulative `usage.output_tokens`. A non-streaming
   * body has top-level `model` and `usage`. Other events (`ping`, `content_block_*`,
   * `error`) have no usage and return null. Cache-read/creation tokens are not
   * priced separately (the SRS has one input and one output price).
   */
  extractUsage(payload: unknown): PartialUsage | null {
    const event = asRecord(payload);
    if (!event) return null;
    const source = asRecord(event['message']) ?? event; // message_start nests it under `message`
    const usage = asRecord(source['usage']) ?? asRecord(event['usage']);
    const result: PartialUsage = {};
    const model = stringOrUndefined(source['model']);
    if (model !== undefined) result.model = model;
    const input = tokenCount(usage?.['input_tokens']);
    const output = tokenCount(usage?.['output_tokens']);
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
