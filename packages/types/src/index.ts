/** Identifier of an LLM provider, e.g. "openai". Sent by clients in the `x-provider` header. */
export type ProviderId = string;

/** Provider usage normalized into one shape (SRS section 9). Populated in Phase 2. */
export interface ProviderUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Per-model price list (SRS section 9). */
export interface ModelPricing {
  provider: string;
  model: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
}

export type EndUserStatus = 'active' | 'blocked' | 'suspended';
export type ApiKeyStatus = 'active' | 'revoked';
