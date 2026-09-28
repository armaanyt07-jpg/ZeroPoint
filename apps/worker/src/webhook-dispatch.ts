import type { WebhookEvent } from '@zeropoint/types';
import type { Telemetry } from './telemetry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['velocity', 'loop'] as const;
const WEBHOOK_TIMEOUT_MS = 5000;

export class InvalidWebhookEventError extends Error {
  constructor() {
    super('Invalid webhook event.');
    this.name = 'InvalidWebhookEventError';
  }
}

/** Queue bodies are untrusted JSON: check the shape before making an outbound HTTP call. */
export function parseWebhookEvent(body: unknown): WebhookEvent {
  const e = body as Partial<Record<keyof WebhookEvent, unknown>> | null;
  if (
    typeof e !== 'object' || e === null ||
    typeof e.tenantId !== 'string' || !UUID.test(e.tenantId) ||
    typeof e.externalUserId !== 'string' || e.externalUserId === '' ||
    !REASONS.includes(e.reason as (typeof REASONS)[number]) ||
    typeof e.openedAt !== 'string' || Number.isNaN(Date.parse(e.openedAt)) ||
    typeof e.expiresAt !== 'string' || Number.isNaN(Date.parse(e.expiresAt)) ||
    typeof e.webhookUrl !== 'string' || !isHttpUrl(e.webhookUrl)
  ) {
    throw new InvalidWebhookEventError();
  }
  return e as WebhookEvent;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The slice of a Cloudflare queue message the consumer uses (so tests can fake it). */
export interface QueueMessageLike {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Retry delay grows 15 s, 30 s, 60 s ... capped at 10 minutes, same policy as settlement. */
export const retryDelaySeconds = (attempts: number) =>
  Math.min(15 * 2 ** Math.max(0, attempts - 1), 600);

/**
 * Sends one webhook notification. A tenant's endpoint is untrusted third-party
 * infrastructure, so failures here (timeout, non-2xx, DNS) are its problem, not a
 * ZeroPoint bug: never let one bad endpoint crash the batch, only mark the message
 * for retry (`fetchImpl` is injected so tests never make a real network call).
 */
async function deliverWebhook(
  event: WebhookEvent,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(event.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'circuit_breaker.opened',
      tenant_id: event.tenantId,
      external_user_id: event.externalUserId,
      reason: event.reason,
      opened_at: event.openedAt,
      expires_at: event.expiresAt,
    }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Webhook endpoint returned HTTP ${response.status}.`);
}

/**
 * Queue consumer entry point (FR-3.7). Each message is delivered independently:
 * success -> ack; any failure -> retry with backoff. After the queue's
 * `max_retries` a message moves to the dead-letter queue (wrangler.toml).
 */
export async function handleWebhookBatch(
  messages: readonly QueueMessageLike[],
  telemetry: Telemetry,
  fetchImpl: typeof fetch,
): Promise<void> {
  await Promise.all(
    messages.map(async (message) => {
      try {
        const event = parseWebhookEvent(message.body);
        await deliverWebhook(event, fetchImpl);
        message.ack();
      } catch (error) {
        telemetry.increment('queue_failures', {
          stage: 'webhook_deliver',
          reason: error instanceof InvalidWebhookEventError ? 'invalid_event' : 'delivery_failed',
        });
        console.error(
          JSON.stringify({ type: 'webhook_delivery_error', name: (error as Error)?.name, attempts: message.attempts }),
        );
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }),
  );
}
