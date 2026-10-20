"use server";

import { endUserCacheKey } from "@zeropoint/schemas";
import { revalidatePath } from "next/cache";
import { adminAction } from "@/lib/action";
import { UserFacingError } from "@/lib/action-core";
import { CACHE_DELAY_NOTE, deleteCacheKeys } from "@/lib/cache";
import { redisEnv } from "@/lib/env";
import { upsertEndUserSchema } from "@/lib/validation";

/**
 * SRS 12 "Create/configure end-user budgets". Creates the user if needed (so a
 * budget can be set before their first request) and never touches their spend.
 * The Worker may have cached "no such user" too (negative cache), so the entry is
 * evicted on create as well as on update.
 */
export const upsertEndUser = adminAction("upsert_end_user", upsertEndUserSchema, async (input, { db }) => {
  const { error } = await db.from("end_users").upsert(
    {
      tenant_id: input.tenantId,
      external_user_id: input.externalUserId,
      budget_limit_usd: input.budgetLimitUsd,
      status: input.status,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,external_user_id" },
  );
  if (error) throw new UserFacingError("Could not save the user. Does this tenant still exist?");
  const evicted = await deleteCacheKeys([endUserCacheKey(input.tenantId, input.externalUserId)], redisEnv());
  revalidatePath(`/t/${input.tenantId}/users`);
  return { message: evicted ? `Saved ${input.externalUserId}. Applies from the next request.` : CACHE_DELAY_NOTE };
});
