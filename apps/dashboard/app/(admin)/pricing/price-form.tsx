"use client";

import { SUPPORTED_PROVIDERS } from "@zeropoint/schemas";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Field, SelectField } from "@/components/field";
import { formatUsd } from "@/lib/format";
import { upsertPrice } from "./actions";

const PROVIDERS = SUPPORTED_PROVIDERS.map((p) => ({ value: p, label: p }));

/**
 * Add or overwrite one model's price. A live example cost makes a slip (per
 * token vs per million) visible before it mis-charges anyone.
 */
export function PriceForm() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const example = (Number(input) * 1000 + Number(output) * 1000) / 1_000_000;
  const valid = input !== "" && output !== "" && Number.isFinite(example);

  return (
    <ActionForm action={upsertPrice} submitLabel="Save price" className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="provider" label="Provider" options={PROVIDERS} defaultValue="openai" />
        <Field
          name="model"
          label="Model"
          required
          placeholder="gpt-4o-mini"
          hint="The family name. Dated snapshots such as -2024-07-18 use this price automatically."
          autoComplete="off"
          spellCheck={false}
        />
        <Field name="inputPerMillionUsd" label="Input (USD per 1M tokens)" inputMode="decimal" required value={input} onChange={(e) => setInput(e.target.value)} />
        <Field name="outputPerMillionUsd" label="Output (USD per 1M tokens)" inputMode="decimal" required value={output} onChange={(e) => setOutput(e.target.value)} />
      </div>
      <p className="text-sm text-muted-foreground">
        Example: 1,000 input + 1,000 output tokens cost{" "}
        <span className="font-mono text-foreground tabular-nums">{valid ? formatUsd(example) : "—"}</span>.
      </p>
    </ActionForm>
  );
}
