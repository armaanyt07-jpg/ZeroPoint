import type { ReactNode } from "react";
import { TenantNav } from "@/components/tenant-nav";
import { getAdminDb } from "@/lib/auth";
import { getTenant, listTenants } from "@/lib/queries";

export default async function TenantLayout({ children, params }: { children: ReactNode; params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const db = await getAdminDb();
  const [tenant, tenants] = await Promise.all([getTenant(db, tenantId), listTenants(db)]);
  return (
    <>
      <TenantNav tenant={{ id: tenant.id, name: tenant.name }} tenants={tenants} />
      {children}
    </>
  );
}
