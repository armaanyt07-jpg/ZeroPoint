import { AnthropicAdapter, GeminiAdapter, createDefaultRegistry } from '@zeropoint/providers';
import { describe, expect, it } from 'vitest';

const req = (path: string, headers: Record<string, string> = {}, method = 'POST') =>
  new Request(`https://zp.example${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: '{"hello":"world"}' } : {}),
  });

const PROXY = { authorization: 'Bearer pk_live_PROXYKEY', 'x-user-id': 'u1', 'x-provider': 'x', cookie: 'a=b' };

describe('AnthropicAdapter (FR-1.4)', () => {
  const adapter = new AnthropicAdapter();

  it('matches only /v1/messages', async () => {
    expect(adapter.matchesPath('/v1/messages')).toBe(true);
    expect(adapter.matchesPath('/v1/chat/completions')).toBe(false);
    expect(await adapter.authenticate(req('/v1/messages', PROXY))).toBe(true);
    expect(await adapter.authenticate(req('/v1/messages'))).toBe(false); // no bearer
    expect(await adapter.authenticate(req('/v1/messages', PROXY, 'GET'))).toBe(false);
    expect(await adapter.authenticate(req('/v1/chat/completions', PROXY))).toBe(false);
  });

  it('targets Anthropic, uses x-api-key, and sends no Authorization header', async () => {
    const out = await adapter.buildProviderRequest(
      req('/v1/messages', { ...PROXY, 'content-type': 'application/json', 'anthropic-version': '2024-01-01' }),
      'sk-ant-REAL',
    );
    expect(out.url).toBe('https://api.anthropic.com/v1/messages');
    expect(out.method).toBe('POST');
    expect(out.headers.get('x-api-key')).toBe('sk-ant-REAL');
    expect(out.headers.get('authorization')).toBeNull();
    expect(out.headers.get('anthropic-version')).toBe('2024-01-01');
    expect([...out.headers.keys()].sort()).toEqual(['anthropic-version', 'content-type', 'x-api-key']);
    expect(JSON.stringify([...out.headers])).not.toContain('PROXYKEY');
    expect(await out.text()).toBe('{"hello":"world"}');
  });

  it('adds a default anthropic-version when the client sends none', async () => {
    const out = await adapter.buildProviderRequest(req('/v1/messages', PROXY), 'k');
    expect(out.headers.get('anthropic-version')).toBe('2023-06-01');
  });

  it('keeps the Phase 2 stub and injected-pricing cost behaviour', () => {
    expect(adapter.parseStreamChunk(new Uint8Array())).toBeNull();
    const priced = new AnthropicAdapter([
      { provider: 'anthropic', model: 'm', inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    ]);
    expect(priced.calculateCost({ model: 'm', inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18);
    expect(() => adapter.calculateCost({ model: 'm', inputTokens: 1, outputTokens: 1 })).toThrow('No pricing');
  });
});

describe('GeminiAdapter (FR-1.4)', () => {
  const adapter = new GeminiAdapter();
  const GEN = '/v1beta/models/gemini-2.0-flash:generateContent';
  const STREAM = '/v1beta/models/gemini-2.0-flash:streamGenerateContent';

  it('matches generateContent / streamGenerateContent on v1 and v1beta', () => {
    expect(adapter.matchesPath(GEN)).toBe(true);
    expect(adapter.matchesPath(STREAM)).toBe(true);
    expect(adapter.matchesPath('/v1/models/gemini-pro:generateContent')).toBe(true);
  });

  it.each([
    '/v1beta/models/x:deleteEverything',
    '/v1beta/models/a/b:generateContent',
    '/v1beta/models/:generateContent',
    '/v1beta/tunedModels/x:generateContent',
    '/v1beta/models/x:generateContent/extra',
    '/v1/chat/completions',
  ])('rejects %s', (path) => {
    expect(adapter.matchesPath(path)).toBe(false);
  });

  it('targets Gemini with x-goog-api-key and the same model path', async () => {
    const out = await adapter.buildProviderRequest(
      req(GEN, { ...PROXY, 'content-type': 'application/json' }),
      'AIza-REAL',
    );
    expect(out.url).toBe(`https://generativelanguage.googleapis.com${GEN}`);
    expect(out.headers.get('x-goog-api-key')).toBe('AIza-REAL');
    expect(out.headers.get('authorization')).toBeNull();
    expect([...out.headers.keys()].sort()).toEqual(['content-type', 'x-goog-api-key']);
    expect(await out.text()).toBe('{"hello":"world"}');
  });

  it('forwards alt=sse for streaming but drops every other query parameter (incl. a client key)', async () => {
    const out = await adapter.buildProviderRequest(req(`${STREAM}?alt=sse&key=CLIENTKEY&foo=bar`, PROXY), 'k');
    expect(out.url).toBe(`https://generativelanguage.googleapis.com${STREAM}?alt=sse`);
    const noAlt = await adapter.buildProviderRequest(req(`${GEN}?key=CLIENTKEY&alt=evil`, PROXY), 'k');
    expect(noAlt.url).toBe(`https://generativelanguage.googleapis.com${GEN}`);
  });

  it('requires POST and a bearer', async () => {
    expect(await adapter.authenticate(req(GEN, PROXY))).toBe(true);
    expect(await adapter.authenticate(req(GEN))).toBe(false);
    expect(await adapter.authenticate(req(GEN, PROXY, 'GET'))).toBe(false);
  });
});

describe('registry path support', () => {
  const registry = createDefaultRegistry();
  it('routes every provider path and nothing else', () => {
    expect(registry.supportsPath('/v1/chat/completions')).toBe(true);
    expect(registry.supportsPath('/v1/messages')).toBe(true);
    expect(registry.supportsPath('/v1beta/models/g:generateContent')).toBe(true);
    expect(registry.supportsPath('/v1/embeddings')).toBe(false);
    expect(registry.supportsPath('/')).toBe(false);
  });
});
