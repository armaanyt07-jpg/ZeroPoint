import type {
  ApiKeyStatus,
  CircuitBreakerEvent,
  EndUserStatus,
  ProviderId,
  TenantPolicy,
  UsageEvent,
} from '@zeropoint/types';

/** Rows we need from PostgreSQL (the durable system of record, SRS 4.1). */
export interface ApiKeyRecord {
  apiKeyId: string;
  tenantId: string;
  status: ApiKeyStatus;
  defaultBudgetUsd: number;
  /** Phase 3 governance policy (SRS 4.3 `tenants` columns), read alongside the key. */
  policy: TenantPolicy;
}

export interface EndUserRecord {
  id: string;
  /** null = no per-user override; fall back to the tenant default. */
  budgetLimitUsd: number | null;
  status: EndUserStatus;
}

/** The database operations the Worker needs. Tests substitute an in-memory fake. */
export interface TenantStore {
  findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  findEndUser(tenantId: string, externalUserId: string): Promise<EndUserRecord | null>;
  /** Returns the AES-GCM ciphertext string (never plaintext). */
  findProviderCredential(tenantId: string, provider: ProviderId): Promise<string | null>;
  /**
   * Governance policy for a tenant, keyed by id alone (settlement has no API key to
   * join through). Never null for an id that owns at least one settled request: the
   * tenant row is a foreign key of `end_users`/`api_keys`, so it must already exist.
   */
  findTenantPolicy(tenantId: string): Promise<TenantPolicy | null>;
}

/** The one database write the Worker performs (FR-2.3): durable, idempotent settlement. */
export interface UsageStore {
  /**
   * Inserts the request log and adds its cost to the user's spend, in one
   * transaction, at most once per `requestId` (FR-2.4). Resolves true if this call
   * settled the request, false if it had already been settled.
   */
  settleUsage(event: UsageEvent): Promise<boolean>;
}

/** FR-3.4's "record the event": an audit trail for the Phase 4 dashboard. */
export interface CircuitBreakerStore {
  /**
   * Best-effort (docs/PHASE_3.md D4): a write failure here is logged, never retried,
   * and never fails the request/settlement message. It is an audit trail, not
   * financial accounting, so it doesn't get `settleUsage`'s durability guarantees.
   */
  recordCircuitBreakerEvent(event: CircuitBreakerEvent): Promise<void>;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null;

function str(row: Row, field: string): string {
  const v = row[field];
  if (typeof v !== 'string') throw new StoreError(`Unexpected shape for ${field}.`);
  return v;
}

/** Postgres NUMERIC may arrive as a JSON number or a string depending on the driver. */
function num(row: Row, field: string): number {
  const n = Number(row[field]);
  if (row[field] === null || row[field] === undefined || !Number.isFinite(n)) {
    throw new StoreError(`Unexpected shape for ${field}.`);
  }
  return n;
}

/** Columns needed from `tenants` for the Phase 3 policy, shared by both call sites below. */
const TENANT_POLICY_COLUMNS = 'velocity_limit_usd,velocity_window_seconds,circuit_breaker_duration_seconds,webhook_url';

function parseTenantPolicy(row: Row): TenantPolicy {
  const webhookUrl = row['webhook_url'];
  return {
    velocityLimitUsd: num(row, 'velocity_limit_usd'),
    velocityWindowSeconds: num(row, 'velocity_window_seconds'),
    circuitBreakerDurationSeconds: num(row, 'circuit_breaker_duration_seconds'),
    webhookUrl: webhookUrl === null ? null : str(row, 'webhook_url'),
  };
}

/**
 * Supabase PostgREST client. PostgREST turns each table into a REST endpoint,
 * which works from a Worker without a database driver. The service-role key
 * bypasses Row Level Security, so it must stay a Worker secret (see migration 003).
 */
export class SupabaseStore implements TenantStore, UsageStore, CircuitBreakerStore {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 2000,
    private readonly writeTimeoutMs = 5000,
  ) {}

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const row = await this.selectOne('api_keys', {
      select: `id,tenant_id,status,tenants(default_budget_usd,${TENANT_POLICY_COLUMNS})`,
      key_hash: `eq.${keyHash}`,
    });
    if (!row) return null;
    const tenant = row['tenants'];
    if (!isObject(tenant)) throw new StoreError('Unexpected shape for tenants.');
    const status = str(row, 'status');
    if (status !== 'active' && status !== 'revoked') throw new StoreError('Unexpected key status.');
    return {
      apiKeyId: str(row, 'id'),
      tenantId: str(row, 'tenant_id'),
      status,
      defaultBudgetUsd: num(tenant, 'default_budget_usd'),
      policy: parseTenantPolicy(tenant),
    };
  }

  async findTenantPolicy(tenantId: string): Promise<TenantPolicy | null> {
    const row = await this.selectOne('tenants', {
      select: TENANT_POLICY_COLUMNS,
      id: `eq.${tenantId}`,
    });
    return row ? parseTenantPolicy(row) : null;
  }

  /** Best-effort insert (CircuitBreakerStore); the caller decides how to handle a failure. */
  async recordCircuitBreakerEvent(event: CircuitBreakerEvent): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/rest/v1/circuit_breaker_events`, {
        method: 'POST',
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          'content-type': 'application/json',
          prefer: 'return=minimal',
        },
        body: JSON.stringify({
          tenant_id: event.tenantId,
          external_user_id: event.externalUserId,
          reason: event.reason,
          opened_at: event.openedAt,
          expires_at: event.expiresAt,
        }),
        signal: AbortSignal.timeout(this.writeTimeoutMs),
      });
    } catch {
      throw new StoreError('Database request failed or timed out.');
    }
    if (!response.ok) throw new StoreError(`Database returned HTTP ${response.status}.`);
  }

  async findEndUser(tenantId: string, externalUserId: string): Promise<EndUserRecord | null> {
    const row = await this.selectOne('end_users', {
      select: 'id,budget_limit_usd,status',
      tenant_id: `eq.${tenantId}`,
      external_user_id: `eq.${externalUserId}`,
    });
    if (!row) return null;
    const status = str(row, 'status');
    if (status !== 'active' && status !== 'blocked' && status !== 'suspended') {
      throw new StoreError('Unexpected user status.');
    }
    return {
      id: str(row, 'id'),
      budgetLimitUsd: row['budget_limit_usd'] === null ? null : num(row, 'budget_limit_usd'),
      status,
    };
  }

  async findProviderCredential(tenantId: string, provider: ProviderId): Promise<string | null> {
    const row = await this.selectOne('tenant_provider_credentials', {
      select: 'encrypted_api_key',
      tenant_id: `eq.${tenantId}`,
      provider: `eq.${provider}`,
    });
    return row ? str(row, 'encrypted_api_key') : null;
  }

  /** Calls the `settle_usage` SQL function (migration 005) through PostgREST RPC. */
  async settleUsage(event: UsageEvent): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/settle_usage`, {
        method: 'POST',
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          p_request_id: event.requestId,
          p_tenant_id: event.tenantId,
          p_external_user_id: event.externalUserId,
          p_provider: event.provider,
          p_model: event.model,
          p_status_code: event.statusCode,
          p_input_tokens: event.inputTokens,
          p_output_tokens: event.outputTokens,
          p_total_tokens: event.totalTokens,
          p_estimated_cost_usd: event.estimatedCostUsd,
          p_usage_source: event.usageSource,
          p_latency_ms: event.latencyMs,
          p_streaming: event.streaming,
          p_created_at: event.occurredAt,
        }),
        signal: AbortSignal.timeout(this.writeTimeoutMs),
      });
    } catch {
      throw new StoreError('Database request failed or timed out.');
    }
    if (!response.ok) throw new StoreError(`Database returned HTTP ${response.status}.`);
    const result = (await response.json()) as unknown;
    if (typeof result !== 'boolean') throw new StoreError('Unexpected database response.');
    return result;
  }

  private async selectOne(table: string, query: Record<string, string>): Promise<Row | null> {
    // URLSearchParams percent-encodes values, so user input can't inject extra filters.
    const params = new URLSearchParams({ ...query, limit: '1' });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/rest/v1/${table}?${params}`, {
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new StoreError('Database request failed or timed out.');
    }
    if (!response.ok) throw new StoreError(`Database returned HTTP ${response.status}.`);
    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows)) throw new StoreError('Unexpected database response.');
    const first: unknown = rows[0];
    if (first === undefined) return null;
    if (!isObject(first)) throw new StoreError('Unexpected database response.');
    return first;
  }
}
