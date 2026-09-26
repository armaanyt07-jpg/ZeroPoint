/**
 * Runtime configuration. Non-secret values could live in wrangler.toml [vars];
 * everything below is a SECRET and is set with `wrangler secret put <NAME>`
 * (or in a git-ignored .dev.vars file locally). Never commit these values.
 */
export interface Env {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Base64-encoded 32-byte key used for AES-256-GCM provider-credential encryption. */
  CREDENTIAL_ENCRYPTION_KEY: string;
}
