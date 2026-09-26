import { decryptSecret } from '@zeropoint/crypto';
import type { ProviderId } from '@zeropoint/types';
import type { Directory } from './directory';
import { ZeroPointError } from './errors';

/**
 * Finds and decrypts the tenant's API key for a provider (FR-1.3).
 * The plaintext lives only in this request's memory: it is never logged,
 * cached, or returned to the client.
 */
export async function resolveProviderCredential(
  directory: Directory,
  encryptionKey: string,
  tenantId: string,
  provider: ProviderId,
): Promise<string> {
  const ciphertext = await directory.getEncryptedCredential(tenantId, provider);
  if (!ciphertext) {
    throw new ZeroPointError(
      400,
      'PROVIDER_NOT_CONFIGURED',
      `No credentials are configured for provider "${provider}".`,
    );
  }
  try {
    // The aad ties this ciphertext to one tenant+provider pair.
    return await decryptSecret(ciphertext, encryptionKey, `${tenantId}:${provider}`);
  } catch {
    throw new ZeroPointError(500, 'INTERNAL_ERROR', 'Unable to use the provider credential.');
  }
}
