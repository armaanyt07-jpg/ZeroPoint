"use server";

import { encryptSecret } from "@zeropoint/crypto";
import { providerCredentialCacheKey } from "@zeropoint/schemas";
import { revalidatePath } from "next/cache";
import { adminAction } from "@/lib/action";
import { UserFacingError } from "@/lib/action-core";
import { CACHE_DELAY_NOTE, deleteCacheKeys } from "@/lib/cache";
import { credentialEncryptionKey, redisEnv } from "@/lib/env";
import { removeCredentialSchema, setCredentialSchema } from "@/lib/validation";

/**
 * SRS 12 "Configure provider credentials". Encrypted here with the same
 * AES-256-GCM key and `<tenantId>:<provider>` binding the Worker decrypts with
 * (docs/PHASE_4_PLAN.md D7). The plaintext is never stored, logged or returned.
 */
export const setCredential = adminAction("set_provider_credential", setCredentialSchema, async (input, { db }) => {
  const encrypted = await encryptSecret(input.apiKey, credentialEncryptionKey(), `${input.tenantId}:${input.provider}`);
  const { error } = await db.from("tenant_provider_credentials").upsert(
    {
      tenant_id: input.tenantId,
      provider: input.provider,
      encrypted_api_key: encrypted,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,provider" },
  );
  if (error) throw new UserFacingError("Could not save the credential. Does this tenant still exist?");
  const evicted = await deleteCacheKeys([providerCredentialCacheKey(input.tenantId, input.provider)], redisEnv());
  revalidatePath(`/t/${input.tenantId}`, "layout");
  return { message: evicted ? `${input.provider} credential saved.` : CACHE_DELAY_NOTE };
});

export const removeCredential = adminAction("remove_provider_credential", removeCredentialSchema, async (input, { db }) => {
  const { error } = await db
    .from("tenant_provider_credentials")
    .delete()
    .eq("tenant_id", input.tenantId)
    .eq("provider", input.provider);
  if (error) throw new Error("credential delete failed");
  const evicted = await deleteCacheKeys([providerCredentialCacheKey(input.tenantId, input.provider)], redisEnv());
  revalidatePath(`/t/${input.tenantId}`, "layout");
  return { message: evicted ? `${input.provider} credential removed.` : CACHE_DELAY_NOTE };
});
