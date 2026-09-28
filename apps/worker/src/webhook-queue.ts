import type { WebhookEvent } from '@zeropoint/types';
import type { Telemetry } from './telemetry';

/** The producer side of the webhook queue (FR-3.7). Tests substitute an in-memory fake. */
export interface WebhookQueue {
  send(event: WebhookEvent): Promise<void>;
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY: RetryOptions = {
  attempts: 3,
  baseDelayMs: 50,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Dispatches a webhook event to the queue, retrying transient failures with
 * exponential backoff, exactly like `dispatchUsageEvent` (usage-queue.ts). This
 * runs inside `waitUntil`/off the settlement critical path (D6: FR-3.7 is
 * "Queue/Worker", never an inline HTTP call from the request or settlement path).
 *
 * If every attempt fails, the notification is lost: the SRS specifies no
 * fallback for a webhook any more than it does for a usage event. We emit
 * `queue_failures` (final=true) and a structured log line with ids only.
 */
export async function dispatchWebhookEvent(
  queue: WebhookQueue,
  event: WebhookEvent,
  telemetry: Telemetry,
  options: Partial<RetryOptions> = {},
): Promise<boolean> {
  const { attempts, baseDelayMs, sleep } = { ...DEFAULT_RETRY, ...options };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await queue.send(event);
      return true;
    } catch {
      const final = attempt === attempts;
      telemetry.increment('queue_failures', { stage: 'produce_webhook', final: String(final) });
      if (final) {
        console.error(
          JSON.stringify({
            type: 'webhook_event_lost',
            tenant_id: event.tenantId,
            reason: event.reason,
          }),
        );
      } else {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  return false;
}
