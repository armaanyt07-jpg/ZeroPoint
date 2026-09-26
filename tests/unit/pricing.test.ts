import { calculateCostUsd, findPricing } from '@zeropoint/pricing';
import { describe, expect, it } from 'vitest';

describe('calculateCostUsd', () => {
  const pricing = { inputPerMillionTokens: 2.5, outputPerMillionTokens: 10 };
  it('applies the SRS section 9 formula', () => {
    expect(calculateCostUsd({ inputTokens: 1_000_000, outputTokens: 500_000 }, pricing)).toBeCloseTo(7.5);
    expect(calculateCostUsd({ inputTokens: 0, outputTokens: 0 }, pricing)).toBe(0);
  });
  it('rejects negative or non-finite values', () => {
    expect(() => calculateCostUsd({ inputTokens: -1, outputTokens: 0 }, pricing)).toThrow(RangeError);
    expect(() => calculateCostUsd({ inputTokens: NaN, outputTokens: 0 }, pricing)).toThrow(RangeError);
  });
  it('finds pricing by provider+model', () => {
    const table = [{ provider: 'openai', model: 'm', ...pricing }];
    expect(findPricing(table, 'openai', 'm')).toBeDefined();
    expect(findPricing(table, 'openai', 'other')).toBeUndefined();
  });
});
