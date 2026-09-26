import { decryptSecret } from '@zeropoint/crypto';
import type { ProviderId } from '@zeropoint/types';
import { ZeroPointError } from './errors';

/**
 * Decrypts the tenant's API key for a provider (FR-1.3). The ciphertext is
 * fetched earlier, in parallel with other lookups (see pipeline.ts); this step
 * only runs once the user has passed the status and budget checks.
 *
 * The plaintext lives only in this request's memory: it is never logged,
 * cached, or returned to the client.
 */
export async function decryptProviderCredential(
  ciphertext: string | null,
  encryptionKey: string,
  tenantId: string,
  provider: ProviderId,
): Promise<string> {
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
