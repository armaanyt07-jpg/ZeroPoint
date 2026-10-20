/**
 * Local/operator helper. Since Phase 4 the dashboard provisions keys, credentials
 * and budgets (FR-4.1); this remains for bootstrapping and scripting.
 *
 *   pnpm helper gen-encryption-key
 *   pnpm helper add-admin <email>                  -> prints the SQL that allowlists the first dashboard admin
 *   pnpm helper generate-proxy-key                 -> prints a new key + its SHA-256 (store only the hash)
 *   pnpm helper hash-key <pk_live_...>
 *   echo -n "sk-provider-key" | CREDENTIAL_ENCRYPTION_KEY=... pnpm helper encrypt-credential <tenantId> <provider>
 *
 * Secrets are read from stdin/env (not argv) so they stay out of shell history.
 */
import { encryptSecret, generateEncryptionKey, generateProxyKey, sha256Hex } from '@zeropoint/crypto';

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
  case 'add-admin': {
    const email = args[0]?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('usage: add-admin <email>');
    // Printed, not executed: run it once in the Supabase SQL editor (docs/PHASE_4.md).
    console.log(`INSERT INTO admins (email) VALUES ('${email.replace(/'/g, "''")}') ON CONFLICT DO NOTHING;`);
    break;
  }
  case 'generate-proxy-key': {
    const { key, keyHash, keyPrefix } = await generateProxyKey();
    console.log(`key (show once, give to the tenant): ${key}`);
    console.log(`key_hash (store in api_keys.key_hash): ${keyHash}`);
    console.log(`key_prefix (store in api_keys.key_prefix): ${keyPrefix}`);
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
    console.error('Commands: gen-encryption-key | add-admin | generate-proxy-key | hash-key | encrypt-credential');
    process.exit(1);
}
