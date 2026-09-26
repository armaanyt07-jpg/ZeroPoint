/**
 * Minimal Upstash Redis client over its REST API.
 *
 * Why REST and not a normal Redis connection? Workers can't open raw TCP
 * connections the way Node can; Upstash exposes Redis over HTTPS instead.
 * Every call is bounded by a timeout so a slow Redis can't stall the proxy
 * (NFR-5.3: the caller decides how to fail open).
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

export class RedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisError';
  }
}

export class UpstashRedis implements RedisClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 1000,
  ) {}

  async get(key: string): Promise<string | null> {
    const result = await this.command(['GET', key]);
    if (result === null || result === undefined) return null;
    // Counters can arrive as JSON numbers. Never drop them: a dropped spend value
    // would read as "$0 spent" and silently disable the budget guardrail.
    if (typeof result === 'string') return result;
    if (typeof result === 'number') return String(result);
    throw new RedisError('Unexpected Redis GET result type.');
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.command(
      ttlSeconds === undefined ? ['SET', key, value] : ['SET', key, value, 'EX', ttlSeconds],
    );
  }

  private async command(args: (string | number)[]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RedisError('Redis request failed or timed out.');
    }
    if (!response.ok) throw new RedisError(`Redis returned HTTP ${response.status}.`);
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (body.error) throw new RedisError('Redis command error.');
    return body.result ?? null;
  }
}
