import { calculateCostUsd, findPricing } from '@zeropoint/pricing';
import type { ModelPricing, PartialUsage, ProviderUsage } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';
import { copyAllowedHeaders, isPostWithBearer, streamingPost } from './shared';
import { asRecord, mergeUsage, parseChunkOnce, stringOrUndefined, tokenCount } from './usage';

const UPSTREAM_ORIGIN = 'https://generativelanguage.googleapis.com';

/**
 * Gemini puts the model and the action in the URL path, e.g.
 *   /v1beta/models/gemini-2.0-flash:generateContent
 *   /v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse
 * The pattern is strict (no slashes, no dots-only segments) so a client can only
 * choose a model name, never a different upstream path.
 */
const PATH_PATTERN = /^\/(v1|v1beta)\/models\/[A-Za-z0-9._-]+:(generateContent|streamGenerateContent)$/;

const FORWARDED_HEADERS = ['content-type', 'accept'];

export class GeminiAdapter implements LLMProviderAdapter {
  readonly id = 'gemini';

  constructor(private readonly pricing: readonly ModelPricing[] = []) {}

  matchesPath(pathname: string): boolean {
    return PATH_PATTERN.test(pathname);
  }

  async authenticate(request: Request): Promise<boolean> {
    return isPostWithBearer(request) && this.matchesPath(new URL(request.url).pathname);
  }

  async buildProviderRequest(request: Request, providerApiKey: string): Promise<Request> {
    const incoming = new URL(request.url);
    const headers = copyAllowedHeaders(request, FORWARDED_HEADERS);
    // Gemini also accepts the key as a `?key=` query parameter; we never forward
    // client query strings except `alt=sse|json`, so a client-supplied key can't slip through.
    headers.set('x-goog-api-key', providerApiKey);

    const url = new URL(incoming.pathname, UPSTREAM_ORIGIN);
    const alt = incoming.searchParams.get('alt');
    if (alt === 'sse' || alt === 'json') url.searchParams.set('alt', alt);
    return streamingPost(url.toString(), headers, request.body);
  }

  parseStreamChunk(chunk: Uint8Array): ProviderUsage | null {
    return parseChunkOnce(this, chunk);
  }

  /**
   * `usageMetadata` (cumulative) is on the response object and, when streaming
   * with `?alt=sse`, on the streamed chunks. Output = `candidatesTokenCount` +
   * `thoughtsTokenCount` (thinking tokens are billed as output). Streaming
   * WITHOUT `alt=sse` returns a JSON array of such objects, so arrays are merged.
   */
  extractUsage(payload: unknown): PartialUsage | null {
    if (Array.isArray(payload)) {
      const merged: PartialUsage = {};
      for (const item of payload as unknown[]) mergeUsage(merged, this.extractUsage(item));
      return Object.keys(merged).length > 0 ? merged : null;
    }
    const body = asRecord(payload);
    if (!body) return null;
    const result: PartialUsage = {};
    const model = stringOrUndefined(body['modelVersion']);
    if (model !== undefined) result.model = model;
    const meta = asRecord(body['usageMetadata']);
    const input = tokenCount(meta?.['promptTokenCount']);
    if (input !== undefined) {
      result.inputTokens = input;
      result.outputTokens =
        (tokenCount(meta?.['candidatesTokenCount']) ?? 0) + (tokenCount(meta?.['thoughtsTokenCount']) ?? 0);
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  /** `/v1beta/models/gemini-2.0-flash:generateContent` -> `gemini-2.0-flash`. */
  modelFromPath(pathname: string): string | null {
    return /^\/(?:v1|v1beta)\/models\/([A-Za-z0-9._-]+):/.exec(pathname)?.[1] ?? null;
  }

  calculateCost(usage: ProviderUsage): number {
    const pricing = findPricing(this.pricing, this.id, usage.model);
    if (!pricing) throw new Error(`No pricing configured for ${this.id}/${usage.model}.`);
    return calculateCostUsd(usage, pricing);
  }
}
