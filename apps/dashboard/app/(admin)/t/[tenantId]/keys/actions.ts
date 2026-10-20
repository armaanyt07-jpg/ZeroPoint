"use server";

import { generateProxyKey } from "@zeropoint/crypto";
import { apiKeyCacheKey } from "@zeropoint/schemas";
import { revalidatePath } from "next/cache";
import { adminAction } from "@/lib/action";
import { UserFacingError } from "@/lib/action-core";
import { CACHE_DELAY_NOTE, deleteCacheKeys } from "@/lib/cache";
import { redisEnv } from "@/lib/env";
import { createKeySchema, revokeKeySchema } from "@/lib/validation";

/**
 * FR-4.1: generate `pk_live_<secret>`, store ONLY its SHA-256 digest, and return
 * the full key this once. It is never stored, logged or retrievable again.
 */
export const createKey = adminAction("create_proxy_key", createKeySchema, async (input, { db }) => {
  const { key, keyHash, keyPrefix } = await generateProxyKey();
  const { error } = await db
    .from("api_keys")
    .insert({ tenant_id: input.tenantId, key_hash: keyHash, key_prefix: keyPrefix, name: input.name });
  if (error) throw new UserFacingError("Could not create the key. Does this tenant still exist?");
  revalidatePath(`/t/${input.tenantId}/keys`);
  return { message: "Key created. Copy it now: it will not be shown again.", data: { key } };
});

/** Revocation takes effect immediately when the Worker's cache entry is evicted (D8). */
export const revokeKey = adminAction("revoke_proxy_key", revokeKeySchema, async (input, { db }) => {
  const { data, error } = await db
    .from("api_keys")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", input.keyId)
    .eq("tenant_id", input.tenantId)
    .eq("status", "active")
    .select("key_hash");
  if (error) throw new Error("revoke failed");
  if (!data?.length) throw new UserFacingError("This key is already revoked or does not exist.");
  const evicted = await deleteCacheKeys(data.map((k) => apiKeyCacheKey(String(k.key_hash))), redisEnv());
  revalidatePath(`/t/${input.tenantId}/keys`);
  return { message: evicted ? "Key revoked. Requests using it are rejected from now on." : CACHE_DELAY_NOTE };
});
