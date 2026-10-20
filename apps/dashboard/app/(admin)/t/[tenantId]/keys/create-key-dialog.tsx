"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { Field } from "@/components/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createKey } from "./actions";

/**
 * FR-4.1 "shown once": the key lives only in this component's state. Closing the
 * dialog drops it; nothing can fetch it again.
 */
export function CreateKeyDialog({ tenantId }: { tenantId: string }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setKey(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>Generate key</Button>
      </DialogTrigger>
      <DialogContent>
        {key ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy your new key</DialogTitle>
              <DialogDescription>Only its SHA-256 digest is stored. Once you close this dialog, the key cannot be shown again.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <code className="rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all">{key}</code>
              <Alert>
                <AlertDescription>
                  Send it as <span className="font-mono">Authorization: Bearer {"<key>"}</span> along with an{" "}
                  <span className="font-mono">x-user-id</span> header.
                </AlertDescription>
              </Alert>
            </div>
            <DialogFooter>
              <CopyButton value={key} label="Copy key" />
              <Button onClick={() => setOpen(false)}>I have copied it</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Generate a proxy key</DialogTitle>
              <DialogDescription>Your customer&apos;s app uses this key instead of a real provider key.</DialogDescription>
            </DialogHeader>
            <ActionForm
              action={createKey}
              submitLabel="Generate"
              pendingLabel="Generating…"
              onSuccess={(data) => setKey(data?.key ?? null)}
            >
              <input type="hidden" name="tenantId" value={tenantId} />
              <Field name="name" label="Label (optional)" placeholder="production" maxLength={100} />
            </ActionForm>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
