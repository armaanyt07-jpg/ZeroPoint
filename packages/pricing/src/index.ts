import type { ModelPricing, ProviderUsage } from '@zeropoint/types';

/**
 * Cost formula from SRS section 9:
 *   total = input_tokens * input_price + output_tokens * output_price
 *
 * Rounded to 8 decimals, the precision of `request_logs.estimated_cost_usd`, so
 * floating-point noise never reaches the ledger.
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
  return Math.round((inputCost + outputCost) * 1e8) / 1e8;
}

export function findPricing(
  table: readonly ModelPricing[],
  provider: string,
  model: string,
): ModelPricing | undefined {
  return table.find((p) => p.provider === provider && p.model === model);
}

/**
 * Version of the price table (SRS section 18: "versioned pricing configuration").
 * Bump it whenever DEFAULT_PRICING changes.
 */
export const PRICING_VERSION = '1';

/**
 * DELIBERATELY EMPTY. The SRS defines the price model (section 9) but specifies
 * no per-model prices, and prices must not be invented. Until an operator adds
 * entries, every model is "unpriced": requests are still logged with their token
 * counts, but cost is 0 and `usage_source` is 'unknown' (docs/PHASE_2.md, D3).
 */
export const DEFAULT_PRICING: readonly ModelPricing[] = [];
