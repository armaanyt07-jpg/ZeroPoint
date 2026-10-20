import "server-only";
import { notFound } from "next/navigation";
import type { AdminDb } from "@/lib/supabase/server";

/**
 * Every read the dashboard makes. Callers must have passed `requireAdmin()` (the
 * admin layout does). Columns are listed explicitly so secrets are never selected:
 * `api_keys.key_hash` and `tenant_provider_credentials.encrypted_api_key` are
 * never read back out.
 */

/** PostgREST returns NUMERIC as a string or a number depending on size. */
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function check<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error || result.data === null) throw new Error(`Could not load ${what}.`);
  return result.data;
}

export interface Tenant {
  id: string;
  name: string;
  defaultBudgetUsd: number;
  velocityLimitUsd: number;
  velocityWindowSeconds: number;
  circuitBreakerDurationSeconds: number;
  webhookUrl: string | null;
  createdAt: string;
}

const TENANT_COLUMNS =
  "id,name,default_budget_usd,velocity_limit_usd,velocity_window_seconds,circuit_breaker_duration_seconds,webhook_url,created_at";

function toTenant(row: Record<string, unknown>): Tenant {
  return {
    id: String(row.id),
    name: String(row.name),
    defaultBudgetUsd: num(row.default_budget_usd),
    velocityLimitUsd: num(row.velocity_limit_usd),
    velocityWindowSeconds: num(row.velocity_window_seconds),
    circuitBreakerDurationSeconds: num(row.circuit_breaker_duration_seconds),
    webhookUrl: (row.webhook_url as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function listTenants(db: AdminDb): Promise<Pick<Tenant, "id" | "name">[]> {
  const rows = check(await db.from("tenants").select("id,name").order("name"), "tenants");
  return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

/** 404s for an unknown or malformed tenant id. */
export async function getTenant(db: AdminDb, tenantId: string): Promise<Tenant> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) notFound();
  const result = await db.from("tenants").select(TENANT_COLUMNS).eq("id", tenantId).maybeSingle();
  if (result.error) throw new Error("Could not load the tenant.");
  if (!result.data) notFound();
  return toTenant(result.data as Record<string, unknown>);
}

export interface Summary {
  totalSpendUsd: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  activeUsers: number;
  openCircuits: number;
}

export interface DailyPoint {
  day: string;
  spendUsd: number;
  requestCount: number;
  totalTokens: number;
}

export interface Spender {
  externalUserId: string;
  spendUsd: number;
  requestCount: number;
  totalTokens: number;
}

export const sinceDaysAgo = (days: number, now = Date.now()) =>
  // Start of the UTC day `days - 1` days ago, so "7 days" is 7 whole chart columns.
  new Date(Math.floor(now / 86_400_000) * 86_400_000 - (days - 1) * 86_400_000).toISOString();

export async function getAnalytics(db: AdminDb, tenantId: string, days: number) {
  const since = sinceDaysAgo(days);
  const args = { p_tenant_id: tenantId, p_since: since };
  const [summary, daily, spenders] = await Promise.all([
    db.rpc("dashboard_summary", args),
    db.rpc("dashboard_daily_spend", args),
    db.rpc("dashboard_top_spenders", { ...args, p_limit: 10 }),
  ]);
  const s = (check(summary, "the summary") as Record<string, unknown>[])[0] ?? {};
  return {
    summary: {
      totalSpendUsd: num(s.total_spend_usd),
      requestCount: num(s.request_count),
      inputTokens: num(s.input_tokens),
      outputTokens: num(s.output_tokens),
      totalTokens: num(s.total_tokens),
      activeUsers: num(s.active_users),
      openCircuits: num(s.open_circuits),
    } satisfies Summary,
    daily: (check(daily, "daily spend") as Record<string, unknown>[]).map(
      (r): DailyPoint => ({
        day: String(r.day).slice(0, 10),
        spendUsd: num(r.spend_usd),
        requestCount: num(r.request_count),
        totalTokens: num(r.total_tokens),
      }),
    ),
    spenders: (check(spenders, "top spenders") as Record<string, unknown>[]).map(
      (r): Spender => ({
        externalUserId: String(r.external_user_id),
        spendUsd: num(r.spend_usd),
        requestCount: num(r.request_count),
        totalTokens: num(r.total_tokens),
      }),
    ),
  };
}

export interface CircuitEvent {
  id: string;
  externalUserId: string;
  reason: "velocity" | "loop";
  openedAt: string;
  expiresAt: string;
  open: boolean;
}

export async function listCircuitEvents(db: AdminDb, tenantId: string, limit = 20): Promise<CircuitEvent[]> {
  const rows = check(
    await db
      .from("circuit_breaker_events")
      .select("id,external_user_id,reason,opened_at,expires_at")
      .eq("tenant_id", tenantId)
      .order("opened_at", { ascending: false })
      .limit(limit),
    "circuit-breaker events",
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: String(r.id),
    externalUserId: String(r.external_user_id),
    reason: r.reason as CircuitEvent["reason"],
    openedAt: String(r.opened_at),
    expiresAt: String(r.expires_at),
    open: Date.parse(String(r.expires_at)) > now,
  }));
}

export interface ApiKeyRow {
  id: string;
  name: string | null;
  keyPrefix: string;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export async function listApiKeys(db: AdminDb, tenantId: string): Promise<ApiKeyRow[]> {
  const rows = check(
    await db
      .from("api_keys")
      .select("id,name,key_prefix,status,last_used_at,created_at,revoked_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    "API keys",
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    keyPrefix: String(r.key_prefix),
    status: r.status as ApiKeyRow["status"],
    lastUsedAt: (r.last_used_at as string | null) ?? null,
    createdAt: String(r.created_at),
    revokedAt: (r.revoked_at as string | null) ?? null,
  }));
}

/** Which providers have a credential, and when it was last set. Never the value. */
export async function listCredentials(db: AdminDb, tenantId: string): Promise<Map<string, string>> {
  const rows = check(
    await db.from("tenant_provider_credentials").select("provider,updated_at").eq("tenant_id", tenantId),
    "provider credentials",
  );
  return new Map(rows.map((r) => [String(r.provider), String(r.updated_at)]));
}

export interface EndUserRow {
  id: string;
  externalUserId: string;
  budgetLimitUsd: number | null;
  currentSpendUsd: number;
  status: "active" | "blocked" | "suspended";
  updatedAt: string;
}

export const USERS_PAGE_SIZE = 50;

/** Search is a case-insensitive prefix match on the external user id. */
export async function listEndUsers(db: AdminDb, tenantId: string, search: string, page: number) {
  let query = db
    .from("end_users")
    .select("id,external_user_id,budget_limit_usd,current_spend_usd,status,updated_at", { count: "exact" })
    .eq("tenant_id", tenantId);
  if (search) query = query.ilike("external_user_id", `${escapeLike(search)}%`);
  const from = (page - 1) * USERS_PAGE_SIZE;
  const result = await query.order("current_spend_usd", { ascending: false }).order("external_user_id").range(from, from + USERS_PAGE_SIZE - 1);
  const rows = check(result, "end users");
  return {
    total: result.count ?? rows.length,
    users: rows.map(
      (r): EndUserRow => ({
        id: String(r.id),
        externalUserId: String(r.external_user_id),
        budgetLimitUsd: numOrNull(r.budget_limit_usd),
        currentSpendUsd: num(r.current_spend_usd),
        status: r.status as EndUserRow["status"],
        updatedAt: String(r.updated_at),
      }),
    ),
  };
}

/** `%`, `_` and `\` are LIKE wildcards; a user id containing them must match literally. */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface PriceRow {
  id: string;
  provider: string;
  model: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  updatedAt: string;
}

export async function listPrices(db: AdminDb): Promise<PriceRow[]> {
  const rows = check(
    await db
      .from("model_prices")
      .select("id,provider,model,input_per_million_usd,output_per_million_usd,updated_at")
      .order("provider")
      .order("model"),
    "model prices",
  );
  return rows.map((r) => ({
    id: String(r.id),
    provider: String(r.provider),
    model: String(r.model),
    inputPerMillionUsd: num(r.input_per_million_usd),
    outputPerMillionUsd: num(r.output_per_million_usd),
    updatedAt: String(r.updated_at),
  }));
}

export interface UnpricedModel {
  provider: string;
  model: string;
  requestCount: number;
  lastSeen: string;
}

export async function listUnpricedModels(db: AdminDb, tenantId: string, days: number): Promise<UnpricedModel[]> {
  const rows = check(
    await db.rpc("dashboard_unpriced_models", { p_tenant_id: tenantId, p_since: sinceDaysAgo(days) }),
    "unpriced models",
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    provider: String(r.provider),
    model: String(r.model),
    requestCount: num(r.request_count),
    lastSeen: String(r.last_seen),
  }));
}
