import type { ApiKeyStatus, EndUserStatus, ProviderId, UsageEvent } from '@zeropoint/types';

/** Rows we need from PostgreSQL (the durable system of record, SRS 4.1). */
export interface ApiKeyRecord {
  apiKeyId: string;
  tenantId: string;
  status: ApiKeyStatus;
  defaultBudgetUsd: number;
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

/**
 * Supabase PostgREST client. PostgREST turns each table into a REST endpoint,
 * which works from a Worker without a database driver. The service-role key
 * bypasses Row Level Security, so it must stay a Worker secret (see migration 003).
 */
export class SupabaseStore implements TenantStore, UsageStore {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 2000,
    private readonly writeTimeoutMs = 5000,
  ) {}

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const row = await this.selectOne('api_keys', {
      select: 'id,tenant_id,status,tenants(default_budget_usd)',
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
    };
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
