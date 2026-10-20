"use client";

import { useState, type ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/action-core";

/** A destructive action behind an AlertDialog. `fields` are the hidden inputs identifying the target. */
export function ConfirmAction<T>({
  action,
  fields,
  trigger,
  title,
  description,
  confirmLabel,
}: {
  action: (state: ActionState<T>, formData: FormData) => Promise<ActionState<T>>;
  fields: Record<string, string>;
  trigger: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="items-center">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <ActionForm action={action} submitLabel={confirmLabel} pendingLabel="Working…" variant="destructive" onSuccess={() => setOpen(false)}>
            {Object.entries(fields).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
          </ActionForm>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
