"use client";

import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { setCredential } from "./actions";

/** Write-only: the field starts empty and is cleared after saving; the stored key is never sent back. */
export function CredentialForm({ tenantId, provider, configured }: { tenantId: string; provider: string; configured: boolean }) {
  return (
    <ActionForm action={setCredential} submitLabel={configured ? "Replace key" : "Save key"} resetOnSuccess className="grid gap-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="provider" value={provider} />
      <Field
        name="apiKey"
        label={configured ? "New API key" : "API key"}
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        placeholder={configured ? "Paste a key to replace the current one" : "Paste the provider API key"}
      />
    </ActionForm>
  );
}
