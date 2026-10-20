"use client";

import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { sendMagicLink } from "./actions";

export function LoginForm() {
  return (
    <ActionForm action={sendMagicLink} submitLabel="Email me a sign-in link" pendingLabel="Sending…">
      <Field name="email" label="Email" type="email" autoComplete="email" required placeholder="you@company.com" />
    </ActionForm>
  );
}
