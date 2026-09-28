import { OpenAIAdapter } from '@zeropoint/providers';
import { describe, expect, it } from 'vitest';

const KEY = 'sk-test-key-1234567890';
const adapter = new OpenAIAdapter();

function req(body: BodyInit | null) {
  return new Request('https://zeropoint.example/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer pk_live_x', 'content-type': 'application/json' },
    ...(body === null ? {} : { body }),
  });
}

async function forwardedText(body: string): Promise<string> {
  return (await adapter.buildProviderRequest(req(body), KEY)).text();
}

describe('OpenAI stream usage opt-in (D2)', () => {
  it('sets stream_options.include_usage for stream:true requests, keeping every other field', async () => {
    const out = JSON.parse(await forwardedText('{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}'));
    expect(out).toEqual({
      model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }], stream_options: { include_usage: true },
    });
  });

  it('keeps other stream_options keys and overrides include_usage:false (governance needs usage)', async () => {
    const out = JSON.parse(await forwardedText('{"stream":true,"stream_options":{"include_usage":false,"x":1}}'));
    expect(out.stream_options).toEqual({ include_usage: true, x: 1 });
  });

  it('replaces a non-object stream_options', async () => {
    const out = JSON.parse(await forwardedText('{"stream":true,"stream_options":null}'));
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it.each([
    ['non-streaming', '{"model":"m","messages":[]}'],
    ['stream:false', '{"model":"m","stream":false}'],
    ['already opted in', '{"stream":true,"stream_options":{ "include_usage" : true }}'],
    ['not JSON', 'this is not json'],
    ['a JSON array', '[{"stream":true}]'],
    ['empty', ''],
  ])('leaves %s bodies byte-for-byte unchanged', async (_name, body) => {
    expect(await forwardedText(body)).toBe(body);
  });

  it('does not touch a request without a body', async () => {
    const upstream = await adapter.buildProviderRequest(req(null), KEY);
    expect(upstream.body).toBeNull();
  });

  it('a body over the inspection cap is forwarded intact (replayed, then streamed) and not modified', async () => {
    const big = '{"stream":true,"pad":"' + 'x'.repeat(2 * 1024 * 1024) + '"}';
    const text = await forwardedText(big);
    expect(text.length).toBe(big.length);
    expect(text).toBe(big);
  });

  it('still replaces the proxy key with the provider key (FR-1.3 unchanged)', async () => {
    const upstream = await adapter.buildProviderRequest(req('{"stream":true}'), KEY);
    expect(upstream.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(upstream.headers.get('content-length')).toBeNull();
  });
});
