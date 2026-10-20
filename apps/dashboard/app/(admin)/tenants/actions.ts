"use server";

import { apiKeyCacheKey } from "@zeropoint/schemas";
import { revalidatePath } from "next/cache";
import { adminAction } from "@/lib/action";
import { UserFacingError } from "@/lib/action-core";
import { CACHE_DELAY_NOTE, deleteCacheKeys } from "@/lib/cache";
import { redisEnv } from "@/lib/env";
import { createTenantSchema, updateTenantSchema } from "@/lib/validation";

const policyColumns = (input: {
  defaultBudgetUsd: number;
  velocityLimitUsd: number;
  velocityWindowSeconds: number;
  circuitBreakerDurationSeconds: number;
  webhookUrl: string | null;
}) => ({
  default_budget_usd: input.defaultBudgetUsd,
  velocity_limit_usd: input.velocityLimitUsd,
  velocity_window_seconds: input.velocityWindowSeconds,
  circuit_breaker_duration_seconds: input.circuitBreakerDurationSeconds,
  webhook_url: input.webhookUrl,
});

/** SRS 12: "Create tenants and configure governance policy." */
export const createTenant = adminAction("create_tenant", createTenantSchema, async (input, { db }) => {
  const { data, error } = await db
    .from("tenants")
    .insert({ name: input.name, ...policyColumns(input) })
    .select("id")
    .single();
  if (error || !data) throw new Error("tenant insert failed");
  revalidatePath("/");
  return { message: `Tenant "${input.name}" created.`, data: { tenantId: String(data.id) } };
});

/**
 * The Worker caches each key's record together with its tenant's policy, so a
 * policy change must evict every one of the tenant's key entries (D8).
 */
export const updateTenant = adminAction("update_tenant", updateTenantSchema, async (input, { db }) => {
  const { data, error } = await db
    .from("tenants")
    .update({ name: input.name, ...policyColumns(input), updated_at: new Date().toISOString() })
    .eq("id", input.tenantId)
    .select("id");
  if (error) throw new Error("tenant update failed");
  if (!data?.length) throw new UserFacingError("This tenant no longer exists.");

  const keys = await db.from("api_keys").select("key_hash").eq("tenant_id", input.tenantId);
  const evicted = !keys.error && (await deleteCacheKeys((keys.data ?? []).map((k) => apiKeyCacheKey(String(k.key_hash))), redisEnv()));
  revalidatePath(`/t/${input.tenantId}`, "layout");
  return {
    message: evicted ? "Settings saved. The proxy uses them from the next request." : CACHE_DELAY_NOTE,
    data: { tenantId: input.tenantId },
  };
});
