/** Identifier of an LLM provider, e.g. "openai". Sent by clients in the `x-provider` header. */
export type ProviderId = string;

/** Provider usage normalized into one shape (SRS section 9). */
export interface ProviderUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Whatever a single SSE event / JSON payload revealed about usage. Providers
 * report usage in pieces (Anthropic: input tokens in `message_start`, output
 * tokens in `message_delta`), so every field is optional and the pieces are
 * merged as the stream is read.
 */
export interface PartialUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** One decoded Server-Sent Event (FR-2.2). Only the fields ZeroPoint needs. */
export interface SseEvent {
  /** The `event:` field, or null when the frame had none (OpenAI, Gemini). */
  event: string | null;
  /** All `data:` lines joined with "\n". */
  data: string;
}

/** Mirrors the `usage_source` CHECK constraint on `request_logs` (SRS 4.3). */
export type UsageSource = 'provider_reported' | 'estimated' | 'unknown';

/**
 * The message sent through Cloudflare Queues (FR-2.3). Metadata only: it never
 * contains prompt or generated text (NFR-5.2). `requestId` is the idempotency
 * key for settlement (FR-2.4).
 */
export interface UsageEvent {
  requestId: string;
  tenantId: string;
  externalUserId: string;
  provider: ProviderId;
  model: string | null;
  statusCode: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** USD, rounded to 8 decimals (the precision of request_logs.estimated_cost_usd). */
  estimatedCostUsd: number;
  usageSource: UsageSource;
  latencyMs: number;
  streaming: boolean;
  /** ISO-8601 time the request was handled; becomes request_logs.created_at. */
  occurredAt: string;
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
