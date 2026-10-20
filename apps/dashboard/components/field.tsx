"use client";

import type { ComponentProps } from "react";
import { FieldError } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Label + input + its validation message. `name` is both the form key and the error key. */
export function Field({
  name,
  label,
  hint,
  ...input
}: { name: string; label: string; hint?: string } & Omit<ComponentProps<typeof Input>, "name">) {
  const id = `field-${name}`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError name={name} />
    </div>
  );
}

/** A native select styled like the inputs: works inside plain <form> submissions with no client state. */
export function SelectField({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string;
}) {
  const id = `field-${name}`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-popover text-popover-foreground">
            {o.label}
          </option>
        ))}
      </select>
      <FieldError name={name} />
    </div>
  );
}
