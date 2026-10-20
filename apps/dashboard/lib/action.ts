import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";
import { buildAdminAction } from "@/lib/action-core";
import { requireAdmin } from "@/lib/auth";
import { createAdminDb, type AdminDb } from "@/lib/supabase/server";

/**
 * Wraps a Server Action so it always runs `requireAdmin()` before anything else.
 * Every exported action in an `actions.ts` file must be built with this
 * (enforced by tests/actions-are-wrapped.test.ts).
 */
export function adminAction<S extends z.ZodType, T = undefined>(
  name: string,
  schema: S,
  handler: (input: z.infer<S>, ctx: { admin: { email: string }; db: AdminDb }) => Promise<{ message: string; data?: T }>,
) {
  return buildAdminAction<AdminDb, S, T>(
    {
      requireAdmin,
      db: createAdminDb,
      rethrowFramework: unstable_rethrow,
      log: (line) => console.log(JSON.stringify(line)),
    },
    name,
    schema,
    handler,
  );
}
