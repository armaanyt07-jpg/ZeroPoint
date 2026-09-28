import { describe, expect, it, vi } from 'vitest';
import {
  InvalidWebhookEventError,
  handleWebhookBatch,
  parseWebhookEvent,
  retryDelaySeconds,
} from '../../apps/worker/src/webhook-dispatch';
import type { WebhookEvent } from '@zeropoint/types';
import { FakeMessage, FakeTelemetry, TENANT_ID, USER_ID } from '../helpers';

const event = (overrides: Partial<WebhookEvent> = {}): WebhookEvent => ({
  tenantId: TENANT_ID,
  externalUserId: USER_ID,
  reason: 'loop',
  webhookUrl: 'https://tenant.example/webhooks/zeropoint',
  openedAt: '2026-09-28T00:00:00.000Z',
  expiresAt: '2026-09-28T00:15:00.000Z',
  ...overrides,
});

describe('parseWebhookEvent (queue bodies are untrusted)', () => {
  it('accepts a valid event', () => {
    expect(parseWebhookEvent(event())).toEqual(event());
    expect(parseWebhookEvent(event({ reason: 'velocity' }))).toBeTruthy();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'x'],
    ['bad tenant id', event({ tenantId: 'nope' })],
    ['empty user', event({ externalUserId: '' })],
    ['unknown reason', event({ reason: 'guess' as never })],
    ['bad opened_at', event({ openedAt: 'yesterday' })],
    ['bad expires_at', event({ expiresAt: 'tomorrow' })],
    ['non-http url', event({ webhookUrl: 'javascript:alert(1)' })],
    ['not a url at all', event({ webhookUrl: 'not a url' })],
    ['missing field', { ...event(), reason: undefined }],
  ])('rejects %s', (_name, body) => {
    expect(() => parseWebhookEvent(body)).toThrow(InvalidWebhookEventError);
  });
});

describe('handleWebhookBatch (queue consumer, FR-3.7)', () => {
  it('POSTs the event and acks on a 2xx response', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(event().webhookUrl);
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ event: 'circuit_breaker.opened', tenant_id: TENANT_ID, reason: 'loop' });
      return new Response(null, { status: 204 });
    });
    const telemetry = new FakeTelemetry();
    const message = new FakeMessage(event());
    await handleWebhookBatch([message], telemetry, fetchImpl as unknown as typeof fetch);
    expect(message.acked).toBe(true);
    expect(message.retried).toBeNull();
  });

  it('retries (does not ack) on a non-2xx response, with backoff, and emits queue_failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const telemetry = new FakeTelemetry();
    const message = new FakeMessage(event(), 3);
    await handleWebhookBatch([message], telemetry, fetchImpl as unknown as typeof fetch);
    expect(message.acked).toBe(false);
    expect(message.retried).toEqual({ delaySeconds: retryDelaySeconds(3) });
    expect(telemetry.events.find((e) => e.metric === 'queue_failures')?.tags).toMatchObject({
      stage: 'webhook_deliver',
      reason: 'delivery_failed',
    });
  });

  it('retries on a network error (the tenant endpoint is untrusted infrastructure)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('DNS failure');
    });
    const telemetry = new FakeTelemetry();
    const message = new FakeMessage(event());
    await handleWebhookBatch([message], telemetry, fetchImpl as unknown as typeof fetch);
    expect(message.acked).toBe(false);
    expect(message.retried).not.toBeNull();
  });

  it('a malformed message is never delivered; it is retried toward the dead-letter queue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn();
    const telemetry = new FakeTelemetry();
    const message = new FakeMessage({ nope: true });
    await handleWebhookBatch([message], telemetry, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(message.acked).toBe(false);
    expect(telemetry.events.find((e) => e.metric === 'queue_failures')?.tags['reason']).toBe('invalid_event');
  });

  it('messages in a batch succeed or fail independently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let call = 0;
    const fetchImpl = vi.fn(async () => (call++ === 0 ? new Response(null, { status: 200 }) : new Response('x', { status: 500 })));
    const telemetry = new FakeTelemetry();
    const a = new FakeMessage(event());
    const b = new FakeMessage(event());
    await handleWebhookBatch([a, b], telemetry, fetchImpl as unknown as typeof fetch);
    expect([a.acked, b.acked].filter(Boolean)).toHaveLength(1);
  });

  it('backoff grows and is capped, same policy as usage settlement', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelaySeconds)).toEqual([15, 30, 60, 120, 240, 480, 600, 600]);
  });
});
