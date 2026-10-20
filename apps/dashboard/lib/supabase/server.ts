import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { serviceRoleKey, supabasePublicEnv } from "@/lib/env";

/**
 * Session client (anon key + the admin's auth cookies). Used ONLY for Supabase
 * Auth: sign-in, sign-out and "who is this?". It cannot read any table, because
 * RLS denies the anon/authenticated roles everything (migration 003).
 */
export async function createSessionClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = supabasePublicEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; proxy.ts refreshes the session instead.
        }
      },
    },
  });
}

/**
 * Service-role client: bypasses RLS. Only call it after `requireAdmin()` (lib/auth.ts);
 * `adminAction` (lib/action.ts) and the admin layout do that for every caller.
 */
export function createAdminDb() {
  return createClient(supabasePublicEnv().url, serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type AdminDb = ReturnType<typeof createAdminDb>;
