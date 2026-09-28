import { describe, expect, it } from 'vitest';
import { dispatchWebhookEvent } from '../../apps/worker/src/webhook-queue';
import { FakeTelemetry, FakeWebhookQueue, TENANT_ID, USER_ID } from '../helpers';

const event = () => ({
  tenantId: TENANT_ID,
  externalUserId: USER_ID,
  reason: 'velocity' as const,
  webhookUrl: 'https://tenant.example/webhooks/zeropoint',
  openedAt: '2026-09-28T00:00:00.000Z',
  expiresAt: '2026-09-28T00:15:00.000Z',
});

describe('dispatchWebhookEvent (FR-3.7, D6: queued, never inline)', () => {
  it('sends once on the happy path', async () => {
    const queue = new FakeWebhookQueue();
    const telemetry = new FakeTelemetry();
    expect(await dispatchWebhookEvent(queue, event(), telemetry, { sleep: async () => {} })).toBe(true);
    expect(queue.sent).toEqual([event()]);
    expect(telemetry.count('queue_failures')).toBe(0);
  });

  it('retries transient failures with backoff and eventually succeeds', async () => {
    const queue = new FakeWebhookQueue();
    queue.failures = 2;
    const telemetry = new FakeTelemetry();
    const sleeps: number[] = [];
    expect(await dispatchWebhookEvent(queue, event(), telemetry, { sleep: async (ms) => void sleeps.push(ms) })).toBe(true);
    expect(queue.attempts).toBe(3);
    expect(sleeps).toEqual([50, 100]);
    expect(telemetry.events.filter((e) => e.metric === 'queue_failures')).toHaveLength(2);
    expect(telemetry.events.every((e) => e.tags['stage'] === 'produce_webhook')).toBe(true);
  });

  it('gives up after every attempt fails, logs ids only (never a URL), and returns false', async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => void logged.push(line);
    try {
      const queue = new FakeWebhookQueue();
      queue.failures = 99;
      const telemetry = new FakeTelemetry();
      expect(await dispatchWebhookEvent(queue, event(), telemetry, { sleep: async () => {} })).toBe(false);
      expect(queue.sent).toHaveLength(0);
      expect(telemetry.events.filter((e) => e.metric === 'queue_failures' && e.tags['final'] === 'true')).toHaveLength(1);
      const line = logged.find((l) => l.includes('webhook_event_lost'))!;
      expect(line).toContain(TENANT_ID);
      expect(line).not.toContain(event().webhookUrl);
    } finally {
      console.error = original;
    }
  });
});
