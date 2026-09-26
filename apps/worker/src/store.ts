import type { ApiKeyStatus, EndUserStatus, ProviderId } from '@zeropoint/types';

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
export class SupabaseStore implements TenantStore {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 2000,
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
