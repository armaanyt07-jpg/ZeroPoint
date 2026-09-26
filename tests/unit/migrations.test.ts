import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real SQL migrations, in order, on an in-process PostgreSQL (PGlite).
 * Until this test existed the migrations had never been executed anywhere.
 */
const DIR = join(import.meta.dirname, '../../database/migrations');
let db: PGlite;

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as Record<string, unknown>;

async function newTenant(budget: number | null = 20) {
  const sql = budget === null
    ? `INSERT INTO tenants (name) VALUES ('t') RETURNING id`
    : `INSERT INTO tenants (name, default_budget_usd) VALUES ('t', ${budget}) RETURNING id`;
  return (await one(sql))['id'] as string;
}

beforeAll(async () => {
  db = new PGlite();
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(DIR, file), 'utf8'));
  }
});

describe('migrations apply cleanly, in order', () => {
  it('creates every table', async () => {
    const { rows } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
    expect(rows.map((r) => (r as { table_name: string }).table_name)).toEqual([
      'api_keys', 'end_users', 'request_logs', 'tenant_provider_credentials', 'tenants',
    ]);
  });

  it('applies the SRS defaults ($20 budget, $2/60s velocity, 15-minute breaker)', async () => {
    const t = await one(`INSERT INTO tenants (name) VALUES ('d') RETURNING default_budget_usd, velocity_limit_usd, velocity_window_seconds, circuit_breaker_duration_seconds`);
    expect(Number(t['default_budget_usd'])).toBe(20);
    expect(Number(t['velocity_limit_usd'])).toBe(2);
    expect(t['velocity_window_seconds']).toBe(60);
    expect(t['circuit_breaker_duration_seconds']).toBe(900);
  });

  it('enables row level security on every table (migration 003)', async () => {
    const { rows } = await db.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('tenants','end_users','api_keys','request_logs','tenant_provider_credentials')`);
    expect(rows).toHaveLength(5);
    for (const r of rows as { relrowsecurity: boolean }[]) expect(r.relrowsecurity).toBe(true);
  });

  it('one credential per tenant and provider (migration 002)', async () => {
    const tenant = await newTenant();
    const insert = `INSERT INTO tenant_provider_credentials (tenant_id, provider, encrypted_api_key) VALUES ($1,'openai','v1:x:y')`;
    await db.query(insert, [tenant]);
    await expect(db.query(insert, [tenant])).rejects.toThrow(/unique|duplicate/i);
  });

  it('api key hashes are unique and status is constrained', async () => {
    const tenant = await newTenant();
    const hash = 'a'.repeat(64);
    const insert = `INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1,$2,'pk_live_')`;
    await db.query(insert, [tenant, hash]);
    await expect(db.query(insert, [tenant, hash])).rejects.toThrow();
    await expect(db.query(`INSERT INTO api_keys (tenant_id, key_hash, key_prefix, status) VALUES ($1,$2,'p','weird')`, [tenant, 'b'.repeat(64)])).rejects.toThrow();
  });
});

describe('non-negative budget constraints (migration 004)', () => {
  it('rejects a negative tenant default budget; accepts 0 and positive', async () => {
    await expect(db.query(`INSERT INTO tenants (name, default_budget_usd) VALUES ('n', -0.0001)`)).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO tenants (name, default_budget_usd) VALUES ('z', 0)`)).resolves.toBeDefined();
    await expect(db.query(`INSERT INTO tenants (name, default_budget_usd) VALUES ('p', 1234.5678)`)).resolves.toBeDefined();
  });

  it('rejects a negative per-user budget; accepts NULL (use tenant default), 0 and positive', async () => {
    const tenant = await newTenant();
    const insert = (id: string, budget: string) =>
      db.query(`INSERT INTO end_users (tenant_id, external_user_id, budget_limit_usd) VALUES ($1,$2,${budget})`, [tenant, id]);
    await expect(insert('neg', '-1')).rejects.toThrow(/check/i);
    await expect(insert('null', 'NULL')).resolves.toBeDefined();
    await expect(insert('zero', '0')).resolves.toBeDefined();
    await expect(insert('pos', '5.5')).resolves.toBeDefined();
  });

  it('rejects updating an existing budget to a negative value', async () => {
    const tenant = await newTenant(10);
    await expect(db.query(`UPDATE tenants SET default_budget_usd = -5 WHERE id = $1`, [tenant])).rejects.toThrow(/check/i);
    await db.query(`INSERT INTO end_users (tenant_id, external_user_id, budget_limit_usd) VALUES ($1,'u',3)`, [tenant]);
    await expect(db.query(`UPDATE end_users SET budget_limit_usd = -1 WHERE external_user_id='u'`)).rejects.toThrow(/check/i);
  });
});
