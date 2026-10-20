/**
 * FR-4.1 proxy keys: `pk_live_<random_secret>`. Only the SHA-256 digest is ever
 * stored (`api_keys.key_hash`); the plaintext is shown to the administrator once.
 */
import { sha256Hex } from './hash';

export const PROXY_KEY_PREFIX = 'pk_live_';
/** 24 random bytes = 192 bits of entropy, 32 base64url characters. */
const SECRET_BYTES = 24;
/** Characters of the key kept in `api_keys.key_prefix` so a key can be recognized without storing it. */
export const KEY_PREFIX_LENGTH = 12;

export interface GeneratedProxyKey {
  /** The full key. Show once, never store or log it. */
  key: string;
  /** SHA-256 hex digest, for `api_keys.key_hash`. */
  keyHash: string;
  /** For `api_keys.key_prefix`. */
  keyPrefix: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generateProxyKey(): Promise<GeneratedProxyKey> {
  const key = PROXY_KEY_PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  return { key, keyHash: await sha256Hex(key), keyPrefix: key.slice(0, KEY_PREFIX_LENGTH) };
}
