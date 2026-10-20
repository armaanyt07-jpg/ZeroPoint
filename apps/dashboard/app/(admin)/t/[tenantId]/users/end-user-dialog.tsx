"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Field, SelectField } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatUsd } from "@/lib/format";
import type { EndUserRow } from "@/lib/queries";
import { upsertEndUser } from "./actions";

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "blocked", label: "Blocked (403 on every request)" },
  { value: "suspended", label: "Suspended (403 on every request)" },
] as const;

/** Add a user (no `user`) or edit one. The external id is the key, so it is fixed when editing. */
export function EndUserDialog({ tenantId, defaultBudgetUsd, user }: { tenantId: string; defaultBudgetUsd: number; user?: EndUserRow }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {user ? (
          <Button variant="ghost" size="sm">
            Edit
          </Button>
        ) : (
          <Button>Add user</Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user ? `Edit ${user.externalUserId}` : "Add an end user"}</DialogTitle>
          <DialogDescription>
            Budgets are lifetime limits. Leave the budget empty to use the tenant default ({formatUsd(defaultBudgetUsd)}).
          </DialogDescription>
        </DialogHeader>
        <ActionForm action={upsertEndUser} submitLabel="Save" onSuccess={() => setOpen(false)}>
          <input type="hidden" name="tenantId" value={tenantId} />
          {user ? (
            <input type="hidden" name="externalUserId" value={user.externalUserId} />
          ) : (
            <Field name="externalUserId" label="User id (the x-user-id your app sends)" required maxLength={128} autoComplete="off" />
          )}
          <Field
            name="budgetLimitUsd"
            label="Budget (USD)"
            inputMode="decimal"
            placeholder={`Tenant default: ${defaultBudgetUsd}`}
            defaultValue={user?.budgetLimitUsd ?? ""}
          />
          <SelectField name="status" label="Status" options={STATUSES} defaultValue={user?.status ?? "active"} />
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
