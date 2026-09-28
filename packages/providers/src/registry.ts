import { DEFAULT_PRICING } from '@zeropoint/pricing';
import type { ModelPricing, ProviderId } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';
import { AnthropicAdapter } from './anthropic';
import { GeminiAdapter } from './gemini';
import { OpenAIAdapter } from './openai';

/** Looks up adapters by provider id. Adding Anthropic/Gemini = write an adapter and add it here. */
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, LLMProviderAdapter>();

  constructor(adapters: readonly LLMProviderAdapter[]) {
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): LLMProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Is this URL path served by any registered provider? */
  supportsPath(pathname: string): boolean {
    return [...this.adapters.values()].some((adapter) => adapter.matchesPath(pathname));
  }

  ids(): ProviderId[] {
    return [...this.adapters.keys()];
  }
}

export function createDefaultRegistry(pricing: readonly ModelPricing[] = DEFAULT_PRICING): ProviderRegistry {
  return new ProviderRegistry([
    new OpenAIAdapter(pricing),
    new AnthropicAdapter(pricing),
    new GeminiAdapter(pricing),
  ]);
}
