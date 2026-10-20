import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/auth";
import { signOut } from "../login/actions";

/** Chrome for every signed-in page. The real check is per page (`getAdminDb`); this one only gates the shell. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { email } = await requireAdmin();
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-6">
          <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
            ZEROPOINT
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              Tenants
            </Link>
            <Link href="/pricing" className="hover:text-foreground">
              Model prices
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{email}</span>
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
