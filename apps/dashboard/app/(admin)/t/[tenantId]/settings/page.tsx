import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TenantForm } from "@/components/tenant-form";
import { getAdminDb } from "@/lib/auth";
import { getTenant } from "@/lib/queries";
import { updateTenant } from "../../../tenants/actions";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const tenant = await getTenant(await getAdminDb(), tenantId);
  return (
    <>
      <PageHeader title="Settings" description="Governance policy and the webhook destination for this tenant." />
      <TenantForm action={updateTenant} tenant={tenant} />
    </>
  );
}
