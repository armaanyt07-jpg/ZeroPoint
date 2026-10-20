"use server";

import { PRICING_CACHE_KEY } from "@zeropoint/schemas";
import { revalidatePath } from "next/cache";
import { adminAction } from "@/lib/action";
import { UserFacingError } from "@/lib/action-core";
import { CACHE_DELAY_NOTE, deleteCacheKeys } from "@/lib/cache";
import { redisEnv } from "@/lib/env";
import { deletePriceSchema, upsertPriceSchema } from "@/lib/validation";

/**
 * Model prices (docs/PHASE_4_PLAN.md D3/D9). Global: every tenant is priced from
 * this table. A change affects requests settled from now on; past request logs
 * keep the cost they were settled with.
 */
export const upsertPrice = adminAction("upsert_model_price", upsertPriceSchema, async (input, { db }) => {
  const { error } = await db.from("model_prices").upsert(
    {
      provider: input.provider,
      model: input.model,
      input_per_million_usd: input.inputPerMillionUsd,
      output_per_million_usd: input.outputPerMillionUsd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,model" },
  );
  if (error) throw new Error("price upsert failed");
  const evicted = await deleteCacheKeys([PRICING_CACHE_KEY], redisEnv());
  revalidatePath("/", "layout");
  return { message: evicted ? `Price for ${input.provider}/${input.model} saved.` : CACHE_DELAY_NOTE };
});

export const deletePrice = adminAction("delete_model_price", deletePriceSchema, async (input, { db }) => {
  const { data, error } = await db.from("model_prices").delete().eq("id", input.priceId).select("id");
  if (error) throw new Error("price delete failed");
  if (!data?.length) throw new UserFacingError("This price no longer exists.");
  const evicted = await deleteCacheKeys([PRICING_CACHE_KEY], redisEnv());
  revalidatePath("/", "layout");
  return { message: evicted ? "Price removed. That model is unpriced from now on." : CACHE_DELAY_NOTE };
});
