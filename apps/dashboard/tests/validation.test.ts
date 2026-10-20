import { describe, expect, it } from "vitest";
import {
  createKeySchema,
  createTenantSchema,
  parseRangeDays,
  setCredentialSchema,
  upsertEndUserSchema,
  upsertPriceSchema,
} from "@/lib/validation";

const TENANT = "11111111-1111-4111-8111-111111111111";
const tenant = (overrides: Record<string, string> = {}) => ({
  name: "Acme",
  defaultBudgetUsd: "20",
  velocityLimitUsd: "2",
  velocityWindowSeconds: "60",
  circuitBreakerDurationSeconds: "900",
  webhookUrl: "",
  ...overrides,
});
const errorsOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => String(i.path[0]));

describe("tenant policy", () => {
  it("accepts the SRS defaults and turns them into numbers; empty webhook = null", () => {
    expect(createTenantSchema.parse(tenant())).toEqual({
      name: "Acme",
      defaultBudgetUsd: 20,
      velocityLimitUsd: 2,
      velocityWindowSeconds: 60,
      circuitBreakerDurationSeconds: 900,
      webhookUrl: null,
    });
  });

  it("budgets fit NUMERIC(12,4): non-negative, at most 4 decimals, no exponent or sign tricks", () => {
    for (const bad of ["-1", "1.23456", "1e3", "", " ", "abc", "123456789", "0x10"]) {
      expect(errorsOf(createTenantSchema.safeParse(tenant({ defaultBudgetUsd: bad }))), bad).toContain("defaultBudgetUsd");
    }
    expect(createTenantSchema.parse(tenant({ defaultBudgetUsd: " 0 " })).defaultBudgetUsd).toBe(0);
    expect(createTenantSchema.parse(tenant({ defaultBudgetUsd: "99999999.9999" })).defaultBudgetUsd).toBe(99999999.9999);
  });

  it("a zero velocity limit is rejected (it would trip on any spend)", () => {
    expect(errorsOf(createTenantSchema.safeParse(tenant({ velocityLimitUsd: "0" })))).toContain("velocityLimitUsd");
  });

  it("windows and durations are whole seconds within bounds", () => {
    expect(errorsOf(createTenantSchema.safeParse(tenant({ velocityWindowSeconds: "9" })))).toContain("velocityWindowSeconds");
    expect(errorsOf(createTenantSchema.safeParse(tenant({ velocityWindowSeconds: "60.5" })))).toContain("velocityWindowSeconds");
    expect(errorsOf(createTenantSchema.safeParse(tenant({ circuitBreakerDurationSeconds: "86401" })))).toContain("circuitBreakerDurationSeconds");
  });

  it("webhooks must be https without embedded credentials", () => {
    for (const bad of ["http://example.com/hook", "ftp://example.com", "not a url", "https://user:pw@example.com/hook", "javascript:alert(1)"]) {
      expect(errorsOf(createTenantSchema.safeParse(tenant({ webhookUrl: bad }))), bad).toContain("webhookUrl");
    }
    expect(createTenantSchema.parse(tenant({ webhookUrl: "https://example.com/hook" })).webhookUrl).toBe("https://example.com/hook");
  });

  it("requires a name", () => {
    expect(errorsOf(createTenantSchema.safeParse(tenant({ name: "   " })))).toContain("name");
  });
});

describe("keys, credentials, users, prices", () => {
  it("rejects a non-UUID tenant id (no PostgREST filter injection through ids)", () => {
    expect(errorsOf(createKeySchema.safeParse({ tenantId: "x,or(1.eq.1)", name: "" }))).toContain("tenantId");
    expect(createKeySchema.parse({ tenantId: TENANT, name: "" }).name).toBeNull();
  });

  it("credentials: supported provider, no whitespace", () => {
    expect(errorsOf(setCredentialSchema.safeParse({ tenantId: TENANT, provider: "mistral", apiKey: "sk-12345678" }))).toContain("provider");
    expect(errorsOf(setCredentialSchema.safeParse({ tenantId: TENANT, provider: "openai", apiKey: "sk-123 45678" }))).toContain("apiKey");
    expect(errorsOf(setCredentialSchema.safeParse({ tenantId: TENANT, provider: "openai", apiKey: "short" }))).toContain("apiKey");
    expect(setCredentialSchema.parse({ tenantId: TENANT, provider: "anthropic", apiKey: "  sk-ant-abcdef12  " }).apiKey).toBe("sk-ant-abcdef12");
  });

  it("end users: empty budget means the tenant default (NULL); ids follow the Worker's x-user-id rules", () => {
    const user = (o: Record<string, string>) => ({ tenantId: TENANT, externalUserId: "u_1", budgetLimitUsd: "", status: "active", ...o });
    expect(upsertEndUserSchema.parse(user({})).budgetLimitUsd).toBeNull();
    expect(upsertEndUserSchema.parse(user({ budgetLimitUsd: "7.5" })).budgetLimitUsd).toBe(7.5);
    expect(errorsOf(upsertEndUserSchema.safeParse(user({ budgetLimitUsd: "-1" })))).toContain("budgetLimitUsd");
    expect(errorsOf(upsertEndUserSchema.safeParse(user({ externalUserId: "a".repeat(129) })))).toContain("externalUserId");
    expect(errorsOf(upsertEndUserSchema.safeParse(user({ externalUserId: "bad\u0007id" })))).toContain("externalUserId");
    expect(errorsOf(upsertEndUserSchema.safeParse(user({ status: "deleted" })))).toContain("status");
  });

  it("prices fit NUMERIC(12,6) and model names have no spaces", () => {
    const price = (o: Record<string, string>) => ({ provider: "openai", model: "gpt-4o-mini", inputPerMillionUsd: "0.15", outputPerMillionUsd: "0.6", ...o });
    expect(upsertPriceSchema.parse(price({}))).toMatchObject({ inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 });
    expect(errorsOf(upsertPriceSchema.safeParse(price({ inputPerMillionUsd: "0.0000001" })))).toContain("inputPerMillionUsd");
    expect(errorsOf(upsertPriceSchema.safeParse(price({ outputPerMillionUsd: "1000000" })))).toContain("outputPerMillionUsd");
    expect(errorsOf(upsertPriceSchema.safeParse(price({ model: "gpt 4o" })))).toContain("model");
  });

  it("analytics range only accepts the offered options", () => {
    expect(parseRangeDays("7")).toBe(7);
    expect(parseRangeDays("90")).toBe(90);
    expect(parseRangeDays("365")).toBe(30);
    expect(parseRangeDays(undefined)).toBe(30);
    expect(parseRangeDays(["7", "90"])).toBe(7);
  });
});
