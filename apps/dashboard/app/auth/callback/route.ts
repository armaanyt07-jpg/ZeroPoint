import { NextResponse, type NextRequest } from "next/server";
import { createSessionClient } from "@/lib/supabase/server";

/**
 * Magic-link landing page (PKCE): trades the one-time `code` for a session
 * cookie. Always redirects to a fixed in-app path, never to a URL from the
 * query string, so the link cannot be turned into an open redirect.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await createSessionClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.redirect(new URL("/login?error=link_invalid", request.url));
}
