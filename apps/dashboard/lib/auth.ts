import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { decideAdmin, type AdminDecision } from "@/lib/authz";
import { createAdminDb, createSessionClient, type AdminDb } from "@/lib/supabase/server";

/**
 * Resolves the signed-in admin once per request (React `cache`). `getUser()`
 * verifies the session with Supabase Auth rather than trusting the cookie.
 */
export const getAdminDecision = cache(async (): Promise<AdminDecision> => {
  const supabase = await createSessionClient();
  const { data } = await supabase.auth.getUser();
  return decideAdmin(data.user, async (email) => {
    const { data: row, error } = await createAdminDb().from("admins").select("email").eq("email", email).maybeSingle();
    if (error) throw new Error("Could not check the admin allowlist.");
    return row !== null;
  });
});

/** The security boundary for pages and actions: returns the admin's email or redirects to /login. */
export async function requireAdmin(): Promise<{ email: string }> {
  const decision = await getAdminDecision();
  if (!decision.allowed) {
    redirect(decision.reason === "no_session" ? "/login" : `/login?error=${decision.reason}`);
  }
  return { email: decision.email };
}

/**
 * The data-access entry point for pages: the service-role client, but only after
 * the admin check. Pages call this rather than relying on the layout's check,
 * because a layout is not re-run on every client-side navigation.
 */
export async function getAdminDb(): Promise<AdminDb> {
  await requireAdmin();
  return createAdminDb();
}
