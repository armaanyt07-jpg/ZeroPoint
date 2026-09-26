import { OpenAIAdapter, ProviderRegistry, createDefaultRegistry } from '@zeropoint/providers';
import { describe, expect, it } from 'vitest';

const post = (headers: Record<string, string> = {}, path = '/v1/chat/completions', method = 'POST') =>
  new Request(`https://zp.example${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: '{"model":"gpt-4o"}' } : {}),
  });

describe('OpenAIAdapter.authenticate', () => {
  const adapter = new OpenAIAdapter();
  it('accepts POST /v1/chat/completions with a Bearer token', async () => {
    expect(await adapter.authenticate(post({ authorization: 'Bearer pk_live_x' }))).toBe(true);
  });
  it('rejects missing bearer, wrong path, wrong method', async () => {
    expect(await adapter.authenticate(post())).toBe(false);
    expect(await adapter.authenticate(post({ authorization: 'Bearer x' }, '/v1/embeddings'))).toBe(false);
    expect(await adapter.authenticate(post({ authorization: 'Bearer x' }, undefined, 'GET'))).toBe(false);
  });
});

describe('OpenAIAdapter.buildProviderRequest', () => {
  const adapter = new OpenAIAdapter();

  it('targets OpenAI and replaces the proxy credential (FR-1.3)', async () => {
    const req = post({
      authorization: 'Bearer pk_live_PROXY',
      'x-user-id': 'u1',
      'x-provider': 'openai',
      cookie: 'session=abc',
      'content-type': 'application/json',
      'openai-organization': 'org-1',
    });
    const out = await adapter.buildProviderRequest(req, 'sk-REAL');
    expect(out.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(out.method).toBe('POST');
    expect(out.headers.get('authorization')).toBe('Bearer sk-REAL');
    expect(out.headers.get('content-type')).toBe('application/json');
    // Nothing else leaks upstream, including client-chosen org/project (Minor 3).
    expect([...out.headers.keys()].sort()).toEqual(['authorization', 'content-type']);
    expect([...out.headers.values()].join()).not.toContain('pk_live_PROXY');
  });

  it('does not let the client choose the billed OpenAI organization or project (Minor 3)', async () => {
    const req = post({
      'content-type': 'application/json',
      'openai-organization': 'org-OTHER',
      'openai-project': 'proj_OTHER',
      'openai-beta': 'assistants=v2',
    });
    const out = await adapter.buildProviderRequest(req, 'k');
    expect(out.headers.get('openai-organization')).toBeNull();
    expect(out.headers.get('openai-project')).toBeNull();
    expect(out.headers.get('openai-beta')).toBe('assistants=v2'); // a feature flag, not billing scope
  });

  it('passes the body through unchanged', async () => {
    const out = await adapter.buildProviderRequest(post({ 'content-type': 'application/json' }), 'k');
    expect(await out.text()).toBe('{"model":"gpt-4o"}');
  });

  it('ignores client-supplied upstream targets (query string, host)', async () => {
    const req = post({ 'x-forwarded-host': 'evil.example' }, '/v1/chat/completions?url=https://evil.example');
    const out = await adapter.buildProviderRequest(req, 'k');
    expect(out.url).toBe('https://api.openai.com/v1/chat/completions');
  });
});

describe('OpenAIAdapter Phase 2 stub / cost', () => {
  it('parseStreamChunk is a Phase 1 stub returning null', () => {
    expect(new OpenAIAdapter().parseStreamChunk(new Uint8Array([1, 2]))).toBeNull();
  });
  it('calculateCost uses the injected pricing table', () => {
    const adapter = new OpenAIAdapter([
      { provider: 'openai', model: 'gpt-x', inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
    ]);
    expect(adapter.calculateCost({ model: 'gpt-x', inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(3);
  });
  it('calculateCost throws when a model has no pricing (Phase 1 ships no table)', () => {
    expect(() => new OpenAIAdapter().calculateCost({ model: 'gpt-x', inputTokens: 1, outputTokens: 1 })).toThrow(
      'No pricing configured',
    );
  });
});

describe('ProviderRegistry', () => {
  it('ships openai, anthropic and gemini (FR-1.4)', () => {
    const registry = createDefaultRegistry();
    expect(registry.ids()).toEqual(['openai', 'anthropic', 'gemini']);
    expect(registry.get('cohere')).toBeUndefined();
  });
  it('accepts additional adapters without other changes', () => {
    const registry = new ProviderRegistry([new OpenAIAdapter(), { ...new OpenAIAdapter(), id: 'future' } as never]);
    expect(registry.ids()).toContain('future');
  });
});
