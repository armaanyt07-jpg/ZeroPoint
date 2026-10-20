"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/lib/action-core";
import { normalizeEmail } from "@/lib/authz";
import { createAdminDb, createSessionClient } from "@/lib/supabase/server";

/*
 * The two actions that must work WITHOUT an admin session, so they are the only
 * ones not built with `adminAction` (tests/actions-are-wrapped.test.ts allows
 * exactly this file).
 */

const SAME_ANSWER = "If this address is allowed to sign in, a sign-in link is on its way. Check your inbox.";

/**
 * Sends a magic link, but only to allowlisted addresses, so strangers cannot
 * create accounts. The reply is identical either way, so it does not reveal who
 * is an admin.
 */
export async function sendMagicLink(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z.email().safeParse(String(formData.get("email") ?? "").trim());
  if (!parsed.success) {
    return { status: "error", message: "Enter a valid email address.", fieldErrors: { email: ["Enter a valid email address."] } };
  }
  const email = normalizeEmail(parsed.data);

  const { data: admin, error } = await createAdminDb().from("admins").select("email").eq("email", email).maybeSingle();
  if (error) return { status: "error", message: "Sign-in is unavailable right now. Try again shortly." };
  if (!admin) return { status: "ok", message: SAME_ANSWER };

  const supabase = await createSessionClient();
  const { error: sendError } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${await siteUrl()}/auth/callback`, shouldCreateUser: true },
  });
  if (sendError) {
    console.error(JSON.stringify({ type: "magic_link_failed", status: sendError.status ?? null }));
    // Usually Supabase's email rate limit; not secret, and the admin needs to know to wait.
    return { status: "error", message: "Could not send the link right now (email rate limit?). Try again in a minute." };
  }
  return { status: "ok", message: SAME_ANSWER };
}

export async function signOut(): Promise<void> {
  const supabase = await createSessionClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/** DASHBOARD_URL when set (recommended in production), else this request's own origin. */
async function siteUrl(): Promise<string> {
  const configured = process.env.DASHBOARD_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
