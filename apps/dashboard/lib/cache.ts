/**
 * Deletes the Worker's read-through cache entries after an administrative change
 * (docs/PHASE_4_PLAN.md D8), so a revoked key or a blocked user takes effect on
 * the next request instead of up to 60 s later.
 *
 * Best-effort: the database write already happened and is the source of truth.
 * Returns false (never throws) when Redis is not configured or the call fails;
 * the caller tells the admin the change applies within the cache TTL.
 */
export interface RedisRestEnv {
  url: string;
  token: string;
}

export async function deleteCacheKeys(
  keys: readonly string[],
  env: RedisRestEnv | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (keys.length === 0) return true;
  if (!env) return false;
  try {
    const response = await fetchImpl(env.url, {
      method: "POST",
      headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
      body: JSON.stringify(["DEL", ...keys]),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { error?: string };
    return !body.error;
  } catch {
    return false;
  }
}

/** Shown next to a successful change whose cache entry could not be deleted. */
export const CACHE_DELAY_NOTE = "Saved. The proxy may keep using the previous value for up to 60 seconds.";
