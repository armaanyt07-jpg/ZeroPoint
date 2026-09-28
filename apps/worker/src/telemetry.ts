/** Metric names from SRS NFR-5.5. `circuit_breaker_events` stays unused until Phase 3. */
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
  /** `value` defaults to 1; `token_usage` and `estimated_spend` carry token counts / USD. */
  increment(metric: MetricName, tags?: Record<string, string>, value?: number): void;
}

/**
 * Writes one structured JSON log line per event. Cloudflare Workers Logs can
 * aggregate these. Tags must never contain credentials (NFR-5.2).
 */
export class ConsoleTelemetry implements Telemetry {
  /** `baseTags` (e.g. the request_id) are added to every event this instance emits. */
  constructor(private readonly baseTags: Record<string, string> = {}) {}

  increment(metric: MetricName, tags: Record<string, string> = {}, value = 1): void {
    console.log(JSON.stringify({ type: 'metric', metric, value, ...this.baseTags, ...tags }));
  }
}
