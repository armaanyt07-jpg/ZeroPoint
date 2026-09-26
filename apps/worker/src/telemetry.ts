/** Metric names from SRS NFR-5.5. Phase 1 only emits the ones marked in docs/PHASE_1.md. */
export type MetricName =
  | 'requests_total'
  | 'requests_allowed'
  | 'requests_rejected'
  | 'budget_rejections'
  | 'circuit_breaker_events'
  | 'redis_failures'
  | 'queue_failures'
  | 'provider_errors'
  | 'streaming_requests'
  | 'token_usage'
  | 'estimated_spend';

export interface Telemetry {
  increment(metric: MetricName, tags?: Record<string, string>): void;
}

/**
 * Writes one structured JSON log line per event. Cloudflare Workers Logs can
 * aggregate these. Tags must never contain credentials (NFR-5.2).
 */
export class ConsoleTelemetry implements Telemetry {
  increment(metric: MetricName, tags: Record<string, string> = {}): void {
    console.log(JSON.stringify({ type: 'metric', metric, value: 1, ...tags }));
  }
}
