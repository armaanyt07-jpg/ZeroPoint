import { calculateCostUsd, findPricing, stripModelVersion } from '@zeropoint/pricing';
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

describe('findPricing version suffixes (Phase 4, D9)', () => {
  const price = (model: string) => ({ provider: 'openai', model, inputPerMillionTokens: 1, outputPerMillionTokens: 2 });
  const table = [price('gpt-4o'), price('gpt-4o-mini'), { ...price('claude-sonnet-4-5'), provider: 'anthropic' }, { ...price('gemini-2.0-flash'), provider: 'gemini' }];

  it('strips only trailing version suffixes', () => {
    expect(stripModelVersion('gpt-4o-mini-2024-07-18')).toBe('gpt-4o-mini');
    expect(stripModelVersion('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(stripModelVersion('gemini-2.0-flash-001')).toBe('gemini-2.0-flash');
    expect(stripModelVersion('claude-3-5-haiku-latest')).toBe('claude-3-5-haiku');
    expect(stripModelVersion('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(stripModelVersion('gpt-4o')).toBe('gpt-4o');
  });

  it('prices a dated snapshot with its family price', () => {
    expect(findPricing(table, 'openai', 'gpt-4o-mini-2024-07-18')?.model).toBe('gpt-4o-mini');
    expect(findPricing(table, 'openai', 'gpt-4o-2024-08-06')?.model).toBe('gpt-4o');
    expect(findPricing(table, 'anthropic', 'claude-sonnet-4-5-20250929')?.model).toBe('claude-sonnet-4-5');
    expect(findPricing(table, 'gemini', 'gemini-2.0-flash-001')?.model).toBe('gemini-2.0-flash');
  });

  it('prefers an exact match over the stripped one', () => {
    const exact = { ...price('gpt-4o-mini-2024-07-18'), inputPerMillionTokens: 9 };
    expect(findPricing([...table, exact], 'openai', 'gpt-4o-mini-2024-07-18')?.inputPerMillionTokens).toBe(9);
  });

  it('never falls back to a different model or provider', () => {
    expect(findPricing([price('gpt-4o')], 'openai', 'gpt-4o-mini')).toBeUndefined();
    expect(findPricing([price('gpt-4o')], 'openai', 'gpt-4o-mini-2024-07-18')).toBeUndefined();
    expect(findPricing(table, 'anthropic', 'gpt-4o')).toBeUndefined();
  });
});

describe('shared provider list (Phase 4)', () => {
  it('the dashboard offers exactly the providers the Worker has adapters for', async () => {
    const { SUPPORTED_PROVIDERS } = await import('@zeropoint/schemas');
    const { createDefaultRegistry } = await import('@zeropoint/providers');
    const registry = createDefaultRegistry();
    expect([...registry.ids()].sort()).toEqual([...SUPPORTED_PROVIDERS].sort());
  });
});
