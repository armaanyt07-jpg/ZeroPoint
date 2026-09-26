/**
 * Local/operator helper. Phase 4 adds proper key provisioning (FR-4.1); until
 * then this lets you seed a database by hand.
 *
 *   pnpm helper gen-encryption-key
 *   pnpm helper generate-proxy-key                 -> prints a new key + its SHA-256 (store only the hash)
 *   pnpm helper hash-key <pk_live_...>
 *   echo -n "sk-provider-key" | CREDENTIAL_ENCRYPTION_KEY=... pnpm helper encrypt-credential <tenantId> <provider>
 *
 * Secrets are read from stdin/env (not argv) so they stay out of shell history.
 */
import { encryptSecret, generateEncryptionKey, sha256Hex } from '@zeropoint/crypto';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'gen-encryption-key':
    console.log(generateEncryptionKey());
    break;
  case 'generate-proxy-key': {
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
    const key = `pk_live_${secret}`;
    console.log(`key (show once, give to the tenant): ${key}`);
    console.log(`key_hash (store in api_keys.key_hash): ${await sha256Hex(key)}`);
    console.log(`key_prefix (store in api_keys.key_prefix): ${key.slice(0, 12)}`);
    break;
  }
  case 'hash-key':
    if (!args[0]) throw new Error('usage: hash-key <key>');
    console.log(await sha256Hex(args[0]));
    break;
  case 'encrypt-credential': {
    const [tenantId, provider] = args;
    const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
    if (!tenantId || !provider || !encryptionKey) {
      throw new Error('usage: CREDENTIAL_ENCRYPTION_KEY=... encrypt-credential <tenantId> <provider> < plaintext');
    }
    console.log(await encryptSecret(await readStdin(), encryptionKey, `${tenantId}:${provider}`));
    break;
  }
  default:
    console.error('Commands: gen-encryption-key | generate-proxy-key | hash-key | encrypt-credential');
    process.exit(1);
}
