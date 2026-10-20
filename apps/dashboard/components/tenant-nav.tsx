"use client";

import { ChevronsUpDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { slug: "", label: "Overview" },
  { slug: "users", label: "Users & budgets" },
  { slug: "keys", label: "Proxy keys" },
  { slug: "providers", label: "Provider credentials" },
  { slug: "settings", label: "Settings" },
  { slug: "operations", label: "Operations" },
] as const;

/** The section of the current tenant URL, so switching tenant keeps you on the same page. */
function currentSection(pathname: string, tenantId: string): string {
  const rest = pathname.slice(`/t/${tenantId}`.length).replace(/^\//, "");
  return rest.split("/")[0] ?? "";
}

export function TenantNav({ tenant, tenants }: { tenant: { id: string; name: string }; tenants: { id: string; name: string }[] }) {
  const pathname = usePathname();
  const section = currentSection(pathname, tenant.id);
  const href = (id: string, slug: string) => (slug ? `/t/${id}/${slug}` : `/t/${id}`);

  return (
    <div className="mb-8 grid gap-4 border-b">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-fit gap-2">
            <span className="max-w-64 truncate">{tenant.name}</span>
            <ChevronsUpDownIcon className="size-4 text-muted-foreground" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Switch tenant</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {tenants.map((t) => (
            <DropdownMenuItem key={t.id} asChild>
              <Link href={href(t.id, section)} aria-current={t.id === tenant.id ? "page" : undefined}>
                <span className="truncate">{t.name}</span>
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/tenants/new">New tenant…</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Tenant sections">
        {SECTIONS.map((s) => {
          const active = s.slug === section;
          return (
            <Link
              key={s.slug}
              href={href(tenant.id, s.slug)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
