import { isValidExternalUserId, MAX_EXTERNAL_USER_ID_LENGTH, SUPPORTED_PROVIDERS } from "@zeropoint/schemas";
import { z } from "zod";

/**
 * Input rules for every administrative form. FormData values are untrusted
 * strings; each schema turns them into exactly what the database column accepts,
 * so a bad value is rejected here with a readable message rather than by a
 * Postgres CHECK with an opaque one.
 */

const uuid = z.uuid({ message: "Invalid id." });

/**
 * A decimal string within a NUMERIC(precision, scale) column. Parsed from text so
 * "0.1" stays 0.1 and an out-of-range value is a form error, not a DB error.
 */
const decimal = (integerDigits: number, scale: number, label: string) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{1,${integerDigits}}(\\.\\d{1,${scale}})?$`), {
      message: `${label} must be a non-negative number with at most ${scale} decimals.`,
    })
    .transform(Number);

/** NUMERIC(12,4): tenants.default_budget_usd, velocity_limit_usd, end_users.budget_limit_usd. */
const usd = (label: string) => decimal(8, 4, label);
/** NUMERIC(12,6): model_prices per-million prices. */
const pricePerMillion = (label: string) => decimal(6, 6, label);

const integerIn = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, { message: `${label} must be a whole number.` })
    .transform(Number)
    .refine((n) => n >= min && n <= max, { message: `${label} must be between ${min} and ${max}.` });

/** Webhook destinations must be HTTPS: the payload names users who were blocked. */
const webhookUrl = z
  .string()
  .trim()
  .max(2048, { message: "Webhook URL is too long." })
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || isHttpsUrl(v), { message: "Webhook URL must be an https:// URL." });

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export const provider = z.enum(SUPPORTED_PROVIDERS, { message: "Unsupported provider." });

const tenantName = z.string().trim().min(1, { message: "Name is required." }).max(100, { message: "Name is too long." });

/** SRS 4.3 `tenants` governance policy (section 12: "configure governance policy"). */
export const tenantPolicyFields = {
  defaultBudgetUsd: usd("Default budget"),
  velocityLimitUsd: usd("Velocity limit").refine((n) => n > 0, { message: "Velocity limit must be greater than 0." }),
  velocityWindowSeconds: integerIn(10, 86_400, "Velocity window"),
  circuitBreakerDurationSeconds: integerIn(60, 86_400, "Circuit breaker duration"),
  webhookUrl,
};

export const createTenantSchema = z.object({ name: tenantName, ...tenantPolicyFields });
export const updateTenantSchema = z.object({ tenantId: uuid, name: tenantName, ...tenantPolicyFields });

export const createKeySchema = z.object({
  tenantId: uuid,
  name: z.string().trim().max(100, { message: "Name is too long." }).transform((v) => (v === "" ? null : v)),
});
export const revokeKeySchema = z.object({ tenantId: uuid, keyId: uuid });

export const setCredentialSchema = z.object({
  tenantId: uuid,
  provider,
  // Provider keys are long opaque tokens; whitespace is always a paste mistake.
  apiKey: z
    .string()
    .trim()
    .min(8, { message: "That does not look like an API key." })
    .max(1000, { message: "API key is too long." })
    .refine((v) => !/\s/.test(v), { message: "API key must not contain spaces." }),
});
export const removeCredentialSchema = z.object({ tenantId: uuid, provider });

const externalUserId = z
  .string()
  .trim()
  .refine(isValidExternalUserId, {
    message: `User id must be 1-${MAX_EXTERNAL_USER_ID_LENGTH} characters with no control characters.`,
  });

/** Empty budget = no per-user override (the tenant default applies), matching NULL in end_users. */
const optionalBudget = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.union([z.null(), usd("Budget")]));

export const userStatus = z.enum(["active", "blocked", "suspended"], { message: "Invalid status." });

export const upsertEndUserSchema = z.object({
  tenantId: uuid,
  externalUserId,
  budgetLimitUsd: optionalBudget,
  status: userStatus,
});

const modelName = z
  .string()
  .trim()
  .min(1, { message: "Model is required." })
  .max(200, { message: "Model name is too long." })
  .refine((v) => !/\s/.test(v), { message: "Model name must not contain spaces." });

export const upsertPriceSchema = z.object({
  provider,
  model: modelName,
  inputPerMillionUsd: pricePerMillion("Input price"),
  outputPerMillionUsd: pricePerMillion("Output price"),
});
export const deletePriceSchema = z.object({ priceId: uuid });

/** Analytics range in days (`?days=`); anything else falls back to 30. */
export const RANGE_OPTIONS = [7, 30, 90] as const;
export function parseRangeDays(value: string | string[] | undefined): (typeof RANGE_OPTIONS)[number] {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return (RANGE_OPTIONS as readonly number[]).includes(n) ? (n as (typeof RANGE_OPTIONS)[number]) : 30;
}
