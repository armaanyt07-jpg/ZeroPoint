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

/**
 * Providers report the exact snapshot that served a request (OpenAI answers a
 * `gpt-4o-mini` request with `gpt-4o-mini-2024-07-18`), but prices are entered per
 * model family. Only a trailing *version* suffix is stripped (a date, a 3-digit
 * revision such as Gemini's `-002`, or `-latest`), never a name segment, so
 * `gpt-4o-mini` can never fall back to the `gpt-4o` price.
 */
const VERSION_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{3}|latest)$/;

export function stripModelVersion(model: string): string {
  return model.replace(VERSION_SUFFIX, '');
}

/** Exact `provider`+`model` match first, then the same model without its version suffix. */
export function findPricing(
  table: readonly ModelPricing[],
  provider: string,
  model: string,
): ModelPricing | undefined {
  const exact = table.find((p) => p.provider === provider && p.model === model);
  if (exact) return exact;
  const base = stripModelVersion(model);
  return base === model ? undefined : table.find((p) => p.provider === provider && p.model === base);
}

/**
 * Version of the price table (SRS section 18: "versioned pricing configuration").
 * Bump it whenever DEFAULT_PRICING changes.
 */
export const PRICING_VERSION = '1';

/**
 * DELIBERATELY EMPTY. The SRS defines the price model (section 9) but specifies
 * no per-model prices, and prices must not be invented. Since Phase 4, operators
 * enter prices in the dashboard (`model_prices` table, docs/PHASE_4_PLAN.md D9) and
 * the Worker prefers those; this static table is only the fallback. A model with
 * no price anywhere is "unpriced": requests are still logged with their token
 * counts, but cost is 0 and `usage_source` is 'unknown' (docs/PHASE_2.md, D3).
 */
export const DEFAULT_PRICING: readonly ModelPricing[] = [];
