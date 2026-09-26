/**
 * AES-256-GCM encryption for secrets stored at rest (NFR-5.2), using only the
 * Web Crypto API so it runs inside a Cloudflare Worker.
 *
 * Stored format:  v1:<base64 iv>:<base64 ciphertext+tag>
 *
 * `aad` ("additional authenticated data") is not encrypted but is authenticated:
 * decryption fails unless the same value is supplied. We bind each credential to
 * "<tenantId>:<provider>" so a ciphertext copied into another row will not decrypt.
 */
const VERSION = 'v1';
const IV_BYTES = 12; // recommended nonce size for GCM
const KEY_BYTES = 32; // 256 bits

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw new CryptoError('Invalid base64 value.');
  }
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);
  if (raw.length !== KEY_BYTES) {
    throw new CryptoError(`Encryption key must be ${KEY_BYTES} bytes (base64-encoded).`);
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Generates a fresh random key, base64-encoded. Used by the dev helper script. */
export function generateEncryptionKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export async function encryptSecret(
  plaintext: string,
  base64Key: string,
  aad: string,
): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES)); // must be unique per encryption
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  payload: string,
  base64Key: string,
  aad: string,
): Promise<string> {
  const parts = payload.split(':');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new CryptoError('Unsupported ciphertext format.');
  }
  const key = await importKey(base64Key);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(parts[1] as string),
        additionalData: new TextEncoder().encode(aad),
      },
      key,
      fromBase64(parts[2] as string),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Wrong key, wrong aad, or tampered data all look the same on purpose.
    throw new CryptoError('Decryption failed.');
  }
}
