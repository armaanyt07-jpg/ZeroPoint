import type { ModelPricing, ProviderUsage } from '@zeropoint/types';

/**
 * Cost formula from SRS section 9:
 *   total = input_tokens * input_price + output_tokens * output_price
 *
 * Phase 1 only ships the formula. The actual price tables and the code that
 * feeds it token counts from streamed responses arrive in Phase 2.
 */
export function calculateCostUsd(
  usage: Pick<ProviderUsage, 'inputTokens' | 'outputTokens'>,
  pricing: Pick<ModelPricing, 'inputPerMillionTokens' | 'outputPerMillionTokens'>,
): number {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    pricing.inputPerMillionTokens,
    pricing.outputPerMillionTokens,
  ];
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new RangeError('Token counts and prices must be finite, non-negative numbers.');
  }
  const inputCost = (usage.inputTokens * pricing.inputPerMillionTokens) / 1_000_000;
  const outputCost = (usage.outputTokens * pricing.outputPerMillionTokens) / 1_000_000;
  return inputCost + outputCost;
}

export function findPricing(
  table: readonly ModelPricing[],
  provider: string,
  model: string,
): ModelPricing | undefined {
  return table.find((p) => p.provider === provider && p.model === model);
}
