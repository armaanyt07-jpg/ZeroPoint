import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminDb } from "@/lib/auth";
import { listTenants } from "@/lib/queries";

export const metadata: Metadata = { title: "Tenants" };

export default async function TenantsPage() {
  const tenants = await listTenants(await getAdminDb());
  return (
    <>
      <PageHeader
        title="Tenants"
        description="Each tenant is one SaaS customer with its own keys, provider credentials, budgets and policy."
        actions={
          <Button asChild>
            <Link href="/tenants/new">New tenant</Link>
          </Button>
        }
      />
      {tenants.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No tenants yet</CardTitle>
            <CardDescription>
              Create a tenant, add a provider credential and generate a proxy key to start routing traffic through ZeroPoint.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tenants.map((t) => (
            <Link key={t.id} href={`/t/${t.id}`} className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
              <Card className="transition-colors hover:bg-accent/40">
                <CardHeader>
                  <CardTitle>{t.name}</CardTitle>
                  <CardDescription className="font-mono text-xs">{t.id}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
