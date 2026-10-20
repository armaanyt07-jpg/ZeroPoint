"use client";

import { useRouter } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Separator } from "@/components/ui/separator";
import type { ActionState } from "@/lib/action-core";
import type { Tenant } from "@/lib/queries";

type TenantAction = (state: ActionState<{ tenantId: string }>, formData: FormData) => Promise<ActionState<{ tenantId: string }>>;

/** SRS 4.3 defaults: $20 budget, $2 per 60 s velocity, 15-minute circuit breaker. */
const DEFAULTS = {
  name: "",
  defaultBudgetUsd: 20,
  velocityLimitUsd: 2,
  velocityWindowSeconds: 60,
  circuitBreakerDurationSeconds: 900,
  webhookUrl: null,
};

export function TenantForm({
  action,
  tenant,
}: {
  action: TenantAction;
  tenant?: Pick<Tenant, "id" | "name" | "defaultBudgetUsd" | "velocityLimitUsd" | "velocityWindowSeconds" | "circuitBreakerDurationSeconds" | "webhookUrl">;
}) {
  const router = useRouter();
  const values = tenant ?? DEFAULTS;
  return (
    <ActionForm
      action={action}
      submitLabel={tenant ? "Save settings" : "Create tenant"}
      onSuccess={(data) => {
        if (!tenant && data) router.push(`/t/${data.tenantId}/providers`);
      }}
      className="grid max-w-2xl gap-6"
    >
      {tenant ? <input type="hidden" name="tenantId" value={tenant.id} /> : null}
      <Field name="name" label="Name" defaultValue={values.name} required maxLength={100} />

      <Separator />
      <div className="grid gap-1">
        <h2 className="text-sm font-medium">Budget</h2>
        <p className="text-sm text-muted-foreground">
          The lifetime spend limit for each end user without their own budget. Requests over it get 429 before the provider is called.
        </p>
      </div>
      <Field name="defaultBudgetUsd" label="Default budget per user (USD)" inputMode="decimal" defaultValue={values.defaultBudgetUsd} required />

      <Separator />
      <div className="grid gap-1">
        <h2 className="text-sm font-medium">Runaway-agent circuit breaker</h2>
        <p className="text-sm text-muted-foreground">
          A user who spends more than the limit within the window, or repeats the same request three times in a row, is blocked for the duration.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field name="velocityLimitUsd" label="Spend limit (USD)" inputMode="decimal" defaultValue={values.velocityLimitUsd} required />
        <Field name="velocityWindowSeconds" label="Window (seconds)" inputMode="numeric" defaultValue={values.velocityWindowSeconds} required />
        <Field name="circuitBreakerDurationSeconds" label="Block for (seconds)" inputMode="numeric" defaultValue={values.circuitBreakerDurationSeconds} required />
      </div>

      <Separator />
      <Field
        name="webhookUrl"
        label="Webhook URL (optional)"
        type="url"
        placeholder="https://example.com/zeropoint-alerts"
        defaultValue={values.webhookUrl ?? ""}
        hint="Receives a POST whenever a user's circuit opens. HTTPS only. Payloads are not signed yet."
      />
    </ActionForm>
  );
}
