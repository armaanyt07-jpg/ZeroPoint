import type { UsageEvent } from '@zeropoint/types';
import type { Telemetry } from './telemetry';

/** The producer side of the usage queue (FR-2.3). Tests substitute an in-memory fake. */
export interface UsageQueue {
  send(event: UsageEvent): Promise<void>;
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
 * Dispatches a usage event, retrying transient failures with exponential
 * backoff. This runs inside `ctx.waitUntil`, entirely off the client's response
 * path, so a slow or failing queue can never stall or break the stream (SRS 8:
 * "retry asynchronously without affecting client stream").
 *
 * If every attempt fails, the event is lost: the SRS specifies no fallback. We
 * emit `queue_failures` (final=true) and a structured log line carrying only
 * ids and numbers, so operators can reconcile from the log.
 */
export async function dispatchUsageEvent(
  queue: UsageQueue,
  event: UsageEvent,
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
      telemetry.increment('queue_failures', { stage: 'produce', final: String(final) });
      if (final) {
        console.error(
          JSON.stringify({
            type: 'usage_event_lost',
            request_id: event.requestId,
            tenant_id: event.tenantId,
            provider: event.provider,
            total_tokens: event.totalTokens,
            estimated_cost_usd: event.estimatedCostUsd,
          }),
        );
      } else {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  return false;
}
