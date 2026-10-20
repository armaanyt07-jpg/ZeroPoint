import { CryptoError, decryptSecret, encryptSecret, generateEncryptionKey, generateProxyKey, sha256Hex } from '@zeropoint/crypto';
import { describe, expect, it } from 'vitest';

describe('sha256Hex', () => {
  it('matches known SHA-256 vectors', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is 64 chars, matching api_keys.key_hash CHAR(64)', async () => {
    expect(await sha256Hex('pk_live_x')).toHaveLength(64);
  });
});

describe('AES-256-GCM', () => {
  const key = generateEncryptionKey();

  it('round-trips a secret', async () => {
    const encrypted = await encryptSecret('sk-secret', key, 'tenant:openai');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('sk-secret');
    expect(await decryptSecret(encrypted, key, 'tenant:openai')).toBe('sk-secret');
  });

  it('uses a fresh IV each time', async () => {
    expect(await encryptSecret('x', key, 'a')).not.toBe(await encryptSecret('x', key, 'a'));
  });

  it('fails with the wrong key', async () => {
    const encrypted = await encryptSecret('sk-secret', key, 'a');
    await expect(decryptSecret(encrypted, generateEncryptionKey(), 'a')).rejects.toThrow(CryptoError);
  });

  it('fails when the aad (tenant:provider binding) differs', async () => {
    const encrypted = await encryptSecret('sk-secret', key, 'tenantA:openai');
    await expect(decryptSecret(encrypted, key, 'tenantB:openai')).rejects.toThrow('Decryption failed');
  });

  it('detects tampering', async () => {
    const [v, iv, ct] = (await encryptSecret('sk-secret', key, 'a')).split(':') as [string, string, string];
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(decryptSecret(`${v}:${iv}:${flipped}`, key, 'a')).rejects.toThrow(CryptoError);
  });

  it('rejects malformed payloads and bad keys', async () => {
    await expect(decryptSecret('garbage', key, 'a')).rejects.toThrow('Unsupported ciphertext format');
    await expect(encryptSecret('x', btoa('short'), 'a')).rejects.toThrow('32 bytes');
    await expect(encryptSecret('x', '***not base64***', 'a')).rejects.toThrow(CryptoError);
  });
});

describe('generateProxyKey (FR-4.1)', () => {
  it('produces pk_live_<32 base64url chars>, its SHA-256 and a 12-char prefix', async () => {
    const { key, keyHash, keyPrefix } = await generateProxyKey();
    expect(key).toMatch(/^pk_live_[A-Za-z0-9_-]{32}$/);
    expect(keyHash).toBe(await sha256Hex(key));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyPrefix).toBe(key.slice(0, 12));
    expect(keyPrefix.startsWith('pk_live_')).toBe(true);
  });

  it('never repeats', async () => {
    const keys = await Promise.all(Array.from({ length: 50 }, () => generateProxyKey()));
    expect(new Set(keys.map((k) => k.key)).size).toBe(50);
  });
});
