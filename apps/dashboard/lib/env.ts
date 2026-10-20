import "server-only";

/**
 * Server-only configuration (Vercel environment variables). Read lazily, per
 * call, so `next build` works without secrets and a missing value fails the one
 * request that needs it with a clear message instead of crashing at import.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

/** Public Supabase settings: safe in the browser, but only used server-side here. */
export const supabasePublicEnv = () => ({
  url: required("NEXT_PUBLIC_SUPABASE_URL"),
  anonKey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
});

/** Bypasses Row Level Security. Never sent to the browser (docs/PHASE_4_PLAN.md D5). */
export const serviceRoleKey = () => required("SUPABASE_SERVICE_ROLE_KEY");

/** Same base64 AES-256 key the Worker uses to decrypt provider credentials (D7). */
export const credentialEncryptionKey = () => required("CREDENTIAL_ENCRYPTION_KEY");

/** For deleting the Worker's cache entries after a change (D8). Optional: without it, changes apply within 60 s. */
export const redisEnv = () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
};
