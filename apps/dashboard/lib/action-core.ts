import { z } from "zod";

/**
 * What every form action returns to `useActionState`. Shaped for the UI only:
 * never raw database rows (Next.js treats action return values as public).
 */
export type ActionState<T = undefined> =
  | { status: "idle" }
  | { status: "ok"; message: string; data?: T }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[] | undefined> };

export const IDLE: ActionState<never> = { status: "idle" };

/** An error whose message is safe and useful to show the admin as-is. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export interface ActionDeps<Db> {
  /** Must throw (redirect) when the caller is not an admin. */
  requireAdmin: () => Promise<{ email: string }>;
  db: () => Db;
  /** Re-throws framework control-flow errors (redirect, notFound). */
  rethrowFramework: (error: unknown) => void;
  log: (line: Record<string, unknown>) => void;
}

/** FormData -> plain object of strings (files are never accepted). */
export function formDataToObject(formData: FormData): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !key.startsWith("$ACTION")) result[key] = value;
  }
  return result;
}

/**
 * The only way the dashboard performs a write (docs/PHASE_4_PLAN.md D5): check the
 * admin FIRST, then validate, then run. Authorization happens before input is
 * even parsed, so an unauthenticated POST learns nothing about the schema.
 */
export function buildAdminAction<Db, S extends z.ZodType, T>(
  deps: ActionDeps<Db>,
  name: string,
  schema: S,
  handler: (input: z.infer<S>, ctx: { admin: { email: string }; db: Db }) => Promise<{ message: string; data?: T }>,
) {
  return async (_previous: ActionState<T>, formData: FormData): Promise<ActionState<T>> => {
    const admin = await deps.requireAdmin();
    const parsed = schema.safeParse(formDataToObject(formData));
    if (!parsed.success) {
      return {
        status: "error",
        message: "Please fix the highlighted fields.",
        fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[] | undefined>,
      };
    }
    try {
      const result = await handler(parsed.data, { admin, db: deps.db() });
      // Audit line: who did what. Inputs are not logged (they can hold provider keys).
      deps.log({ type: "admin_action", action: name, admin: admin.email, ok: true });
      return { status: "ok", ...result };
    } catch (error) {
      deps.rethrowFramework(error);
      deps.log({ type: "admin_action", action: name, admin: admin.email, ok: false, error: (error as Error)?.name });
      if (error instanceof UserFacingError) return { status: "error", message: error.message };
      return { status: "error", message: "Something went wrong. Please try again." };
    }
  };
}
