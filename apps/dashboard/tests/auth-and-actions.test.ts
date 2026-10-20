import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildAdminAction, formDataToObject, IDLE, UserFacingError, type ActionDeps } from "@/lib/action-core";
import { decideAdmin } from "@/lib/authz";

describe("decideAdmin (docs/PHASE_4_PLAN.md D1)", () => {
  const allow = (emails: string[]) => vi.fn(async (email: string) => emails.includes(email));

  it("no session", async () => {
    expect(await decideAdmin(null, allow([]))).toEqual({ allowed: false, reason: "no_session" });
  });

  it("an unconfirmed email is never trusted, even if allowlisted", async () => {
    const check = allow(["ops@example.com"]);
    expect(await decideAdmin({ email: "ops@example.com", email_confirmed_at: null }, check)).toEqual({ allowed: false, reason: "unconfirmed_email" });
    expect(check).not.toHaveBeenCalled();
  });

  it("allowlist lookup is case-insensitive", async () => {
    expect(await decideAdmin({ email: " Ops@Example.COM ", email_confirmed_at: "2026-10-10T00:00:00Z" }, allow(["ops@example.com"]))).toEqual({
      allowed: true,
      email: "ops@example.com",
    });
  });

  it("a confirmed but unlisted user is refused", async () => {
    expect(await decideAdmin({ email: "x@example.com", email_confirmed_at: "2026-10-10T00:00:00Z" }, allow(["ops@example.com"]))).toEqual({
      allowed: false,
      reason: "not_allowlisted",
    });
  });
});

describe("buildAdminAction (every dashboard write goes through it)", () => {
  class Redirect extends Error {}
  const schema = z.object({ amount: z.string().regex(/^\d+$/).transform(Number) });
  const form = (entries: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  };
  function deps(admin: boolean) {
    const log = vi.fn();
    const d: ActionDeps<string> = {
      requireAdmin: async () => {
        if (!admin) throw new Redirect("/login");
        return { email: "ops@example.com" };
      },
      db: () => "db",
      rethrowFramework: (e) => {
        if (e instanceof Redirect) throw e;
      },
      log,
    };
    return { d, log };
  }

  it("checks the admin before validating or running anything", async () => {
    const handler = vi.fn();
    const { d } = deps(false);
    const action = buildAdminAction(d, "x", schema, handler);
    await expect(action(IDLE, form({ amount: "not a number" }))).rejects.toBeInstanceOf(Redirect);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns field errors without running the handler", async () => {
    const handler = vi.fn();
    const action = buildAdminAction(deps(true).d, "x", schema, handler);
    const result = await action(IDLE, form({ amount: "-1" }));
    expect(result).toMatchObject({ status: "error", fieldErrors: { amount: [expect.any(String)] } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes parsed input and the admin to the handler, and audits who did it without logging inputs", async () => {
    const { d, log } = deps(true);
    const action = buildAdminAction(d, "set_amount", schema, async (input, ctx) => ({ message: `ok ${input.amount} ${ctx.admin.email} ${ctx.db}` }));
    expect(await action(IDLE, form({ amount: "42", secret: "sk-should-not-be-logged" }))).toEqual({ status: "ok", message: "ok 42 ops@example.com db" });
    expect(log).toHaveBeenCalledWith({ type: "admin_action", action: "set_amount", admin: "ops@example.com", ok: true });
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-should-not-be-logged");
  });

  it("shows UserFacingError messages, hides everything else", async () => {
    const { d } = deps(true);
    const userFacing = buildAdminAction(d, "x", schema, async () => {
      throw new UserFacingError("Already revoked.");
    });
    const internal = buildAdminAction(d, "x", schema, async () => {
      throw new Error("relation api_keys does not exist; key_hash=abc");
    });
    expect(await userFacing(IDLE, form({ amount: "1" }))).toEqual({ status: "error", message: "Already revoked." });
    const hidden = await internal(IDLE, form({ amount: "1" }));
    expect(hidden.status).toBe("error");
    expect(JSON.stringify(hidden)).not.toContain("key_hash");
  });

  it("lets framework control flow (redirect) through", async () => {
    const action = buildAdminAction(deps(true).d, "x", schema, async () => {
      throw new Redirect("/elsewhere");
    });
    await expect(action(IDLE, form({ amount: "1" }))).rejects.toBeInstanceOf(Redirect);
  });

  it("formDataToObject drops Next.js action fields and files", () => {
    const fd = form({ a: "1", $ACTION_ID_abc: "", $ACTION_REF_1: "" });
    fd.set("file", new Blob(["x"]), "f.txt");
    expect(formDataToObject(fd)).toEqual({ a: "1" });
  });
});
