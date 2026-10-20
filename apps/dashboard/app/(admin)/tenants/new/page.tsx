import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TenantForm } from "@/components/tenant-form";
import { getAdminDb } from "@/lib/auth";
import { createTenant } from "../actions";

export const metadata: Metadata = { title: "New tenant" };

export default async function NewTenantPage() {
  await getAdminDb(); // admin check; this page reads no data
  return (
    <>
      <PageHeader title="New tenant" description="Defaults follow the SRS: $20 per user, $2 per 60 seconds, 15-minute block." />
      <TenantForm action={createTenant} />
    </>
  );
}
