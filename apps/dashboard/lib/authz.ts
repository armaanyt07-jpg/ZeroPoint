/**
 * The admin decision itself, kept free of Next.js/Supabase imports so it can be
 * unit-tested. Supabase Auth proves identity; the `admins` table (migration 007)
 * grants access (docs/PHASE_4_PLAN.md D1).
 */
export interface SessionUser {
  email?: string | null | undefined;
  email_confirmed_at?: string | null | undefined;
}

export type AdminDecision =
  | { allowed: true; email: string }
  | { allowed: false; reason: "no_session" | "unconfirmed_email" | "not_allowlisted" };

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function decideAdmin(
  user: SessionUser | null,
  isAllowlisted: (email: string) => Promise<boolean>,
): Promise<AdminDecision> {
  if (!user?.email) return { allowed: false, reason: "no_session" };
  // An unconfirmed address proves nothing about who owns it.
  if (!user.email_confirmed_at) return { allowed: false, reason: "unconfirmed_email" };
  const email = normalizeEmail(user.email);
  return (await isAllowlisted(email)) ? { allowed: true, email } : { allowed: false, reason: "not_allowlisted" };
}
