import type { ProviderId } from '@zeropoint/types';
import type { LLMProviderAdapter } from './adapter';
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

  ids(): ProviderId[] {
    return [...this.adapters.keys()];
  }
}

export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry([new OpenAIAdapter()]);
}
