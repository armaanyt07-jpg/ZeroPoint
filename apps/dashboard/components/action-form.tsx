"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { IDLE, type ActionState } from "@/lib/action-core";

type FormAction<T> = (state: ActionState<T>, formData: FormData) => Promise<ActionState<T>>;

const FieldErrorsContext = createContext<Record<string, string[] | undefined>>({});

/** Field-level messages from the last submission (rendered by <FieldError>). */
export const useFieldErrors = () => useContext(FieldErrorsContext);

/**
 * One form, one Server Action, driven by `useActionState`. The outcome is shown
 * as a toast; field errors are shown next to their inputs.
 *
 * Submitted through onSubmit + startTransition rather than `<form action>`: React
 * resets a form after a form action runs, which would wipe what the admin typed
 * whenever validation fails. Here fields keep their values unless
 * `resetOnSuccess` asks for a reset.
 */
export function ActionForm<T>({
  action,
  children,
  submitLabel,
  pendingLabel = "Saving…",
  variant = "default",
  resetOnSuccess = false,
  onSuccess,
  className,
}: {
  action: FormAction<T>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "default" | "destructive" | "outline" | "secondary";
  resetOnSuccess?: boolean;
  onSuccess?: (data: T | undefined) => void;
  className?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // Latest callbacks, read when the action settles (the render that started it may be stale).
  const callbacks = useRef({ onSuccess, resetOnSuccess });
  useEffect(() => {
    callbacks.current = { onSuccess, resetOnSuccess };
  });

  // Feedback is given as soon as the action settles, not from an effect after the
  // next render: the action's response often re-renders the page without this form
  // (a revoked key's row no longer has a Revoke button), and an effect in an
  // unmounted form would never run, so the admin would get no confirmation.
  const [state, formAction, pending] = useActionState(async (previous: ActionState<T>, formData: FormData) => {
    const result = await action(previous, formData);
    if (result.status === "ok") {
      toast.success(result.message);
      if (callbacks.current.resetOnSuccess) formRef.current?.reset();
      callbacks.current.onSuccess?.(result.data);
    } else if (result.status === "error") {
      toast.error(result.message);
    }
    return result;
  }, IDLE as ActionState<T>);

  return (
    <FieldErrorsContext value={state.status === "error" ? (state.fieldErrors ?? {}) : {}}>
      <form
        ref={formRef}
        className={className ?? "grid gap-4"}
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startTransition(() => formAction(formData));
        }}
      >
        {children}
        <div>
          <Button type="submit" variant={variant} disabled={pending}>
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </FieldErrorsContext>
  );
}

export function FieldError({ name }: { name: string }) {
  const errors = useFieldErrors()[name];
  if (!errors?.length) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      {errors[0]}
    </p>
  );
}
