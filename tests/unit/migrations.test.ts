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
      'api_keys', 'circuit_breaker_events', 'end_users', 'request_logs', 'tenant_provider_credentials', 'tenants',
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

describe('settlement (migration 005, FR-2.3 / FR-2.4)', () => {
  const REQ = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const settle = (tenant: string, request: string, user = 'u1', cost = 0.00003, extra: { model?: string | null; streaming?: boolean } = {}) =>
    one(
      `SELECT settle_usage($1,$2,$3,'openai',$4,200,100,50,150,$5,'provider_reported',120,$6,'2026-09-26T10:00:00Z') AS settled`,
      [request, tenant, user, extra.model === undefined ? 'gpt-x' : extra.model, cost, extra.streaming ?? true],
    );
  const spendOf = async (tenant: string, user = 'u1') =>
    Number((await one(`SELECT current_spend_usd FROM end_users WHERE tenant_id=$1 AND external_user_id=$2`, [tenant, user]))['current_spend_usd']);

  it('widens current_spend_usd to NUMERIC(14,8) so tiny costs are not rounded away', async () => {
    const col = await one(`SELECT numeric_precision p, numeric_scale s FROM information_schema.columns WHERE table_name='end_users' AND column_name='current_spend_usd'`);
    expect([col['p'], col['s']]).toEqual([14, 8]);
    const tenant = await newTenant();
    for (let i = 0; i < 100; i++) await settle(tenant, REQ(1000 + i), 'tiny', 0.00003);
    expect(await spendOf(tenant, 'tiny')).toBeCloseTo(0.003, 10); // 100 x $0.00003; a 4-decimal column would give $0.0000-0.0100 noise
  });

  it('creates the end user and the request log, and adds the cost once', async () => {
    const tenant = await newTenant();
    expect((await settle(tenant, REQ(1)))['settled']).toBe(true);
    expect(await spendOf(tenant)).toBeCloseTo(0.00003, 10);
    const log = await one(`SELECT * FROM request_logs WHERE request_id=$1`, [REQ(1)]);
    expect(log).toMatchObject({ provider: 'openai', model: 'gpt-x', status_code: 200, usage_source: 'provider_reported', latency_ms: 120, streaming: true, circuit_breaker_triggered: false });
    expect([Number(log['input_tokens']), Number(log['output_tokens']), Number(log['total_tokens'])]).toEqual([100, 50, 150]);
    expect(Number(log['estimated_cost_usd'])).toBeCloseTo(0.00003, 10);
    expect(new Date(log['created_at'] as string).toISOString()).toBe('2026-09-26T10:00:00.000Z');
    const user = await one(`SELECT id FROM end_users WHERE tenant_id=$1 AND external_user_id='u1'`, [tenant]);
    expect(log['end_user_id']).toBe(user['id']);
  });

  it('is idempotent: the same request_id settles once and returns false afterwards (FR-2.4)', async () => {
    const tenant = await newTenant();
    expect((await settle(tenant, REQ(2), 'u1', 1))['settled']).toBe(true);
    expect((await settle(tenant, REQ(2), 'u1', 1))['settled']).toBe(false);
    expect((await settle(tenant, REQ(2), 'u1', 1))['settled']).toBe(false);
    expect(await spendOf(tenant)).toBe(1);
    expect(Number((await one(`SELECT count(*) c FROM request_logs WHERE request_id=$1`, [REQ(2)]))['c'])).toBe(1);
  });

  it('is idempotent under concurrent redelivery of the same request_id', async () => {
    const tenant = await newTenant();
    const results = await Promise.all(Array.from({ length: 8 }, () => settle(tenant, REQ(3), 'u1', 2)));
    expect(results.filter((r) => r['settled'] === true)).toHaveLength(1);
    expect(await spendOf(tenant)).toBe(2);
  });

  it('accumulates different requests and keeps tenants and users separate', async () => {
    const a = await newTenant();
    const b = await newTenant();
    await settle(a, REQ(10), 'u1', 1);
    await settle(a, REQ(11), 'u1', 2);
    await settle(a, REQ(12), 'u2', 4);
    await settle(b, REQ(13), 'u1', 8);
    expect([await spendOf(a, 'u1'), await spendOf(a, 'u2'), await spendOf(b, 'u1')]).toEqual([3, 4, 8]);
  });

  it('keeps an existing end user (budget, status) and adds to their spend', async () => {
    const tenant = await newTenant();
    await db.query(`INSERT INTO end_users (tenant_id, external_user_id, budget_limit_usd, status, current_spend_usd) VALUES ($1,'vip',7.5,'suspended',1)`, [tenant]);
    await settle(tenant, REQ(20), 'vip', 0.5);
    const user = await one(`SELECT budget_limit_usd b, status s, current_spend_usd c FROM end_users WHERE tenant_id=$1 AND external_user_id='vip'`, [tenant]);
    expect([Number(user['b']), user['s'], Number(user['c'])]).toEqual([7.5, 'suspended', 1.5]);
  });

  it('accepts a null model and an unknown-usage zero-cost row', async () => {
    const tenant = await newTenant();
    await db.query(`SELECT settle_usage($1,$2,'u',$3,NULL,200,0,0,0,0,'unknown',5,FALSE,NULL)`, [REQ(30), tenant, 'openai']);
    const log = await one(`SELECT model, usage_source, streaming, created_at FROM request_logs WHERE request_id=$1`, [REQ(30)]);
    expect(log).toMatchObject({ model: null, usage_source: 'unknown', streaming: false });
    expect(log['created_at']).toBeTruthy();
  });

  it('rejects an invalid usage_source (the SRS CHECK still applies) and leaves spend untouched', async () => {
    const tenant = await newTenant();
    await expect(db.query(`SELECT settle_usage($1,$2,'u','openai','m',200,1,1,2,9,'guess',1,FALSE,NULL)`, [REQ(31), tenant])).rejects.toThrow(/check/i);
    expect(Number((await one(`SELECT count(*) c FROM request_logs WHERE request_id=$1`, [REQ(31)]))['c'])).toBe(0);
  });

  it('is not executable by PUBLIC (RLS does not protect functions; only service_role may call it)', async () => {
    const { rows } = await db.query(`SELECT has_function_privilege('public', 'settle_usage(uuid,uuid,text,text,text,integer,bigint,bigint,bigint,numeric,text,integer,boolean,timestamptz)', 'EXECUTE') AS ok`);
    expect((rows[0] as { ok: boolean }).ok).toBe(false);
  });
});

describe('circuit_breaker_events (migration 006, FR-3.4 "record the event")', () => {
  it('records a trip without requiring an end_users row to already exist', async () => {
    const tenant = await newTenant();
    const row = await one(
      `INSERT INTO circuit_breaker_events (tenant_id, external_user_id, reason, opened_at, expires_at)
       VALUES ($1, 'user_never_settled', 'loop', NOW(), NOW() + INTERVAL '15 minutes') RETURNING id, reason`,
      [tenant],
    );
    expect(row['reason']).toBe('loop');
    expect(row['id']).toBeTruthy();
  });

  it('only accepts velocity or loop as a reason', async () => {
    const tenant = await newTenant();
    await expect(
      db.query(
        `INSERT INTO circuit_breaker_events (tenant_id, external_user_id, reason, opened_at, expires_at) VALUES ($1,'u','guess',NOW(),NOW())`,
        [tenant],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('is deleted when its tenant is deleted (cascade, like the other tenant-scoped tables)', async () => {
    const tenant = await newTenant();
    await db.query(
      `INSERT INTO circuit_breaker_events (tenant_id, external_user_id, reason, opened_at, expires_at) VALUES ($1,'u','velocity',NOW(),NOW())`,
      [tenant],
    );
    await db.query(`DELETE FROM tenants WHERE id=$1`, [tenant]);
    const { rows } = await db.query(`SELECT 1 FROM circuit_breaker_events WHERE tenant_id=$1`, [tenant]);
    expect(rows).toHaveLength(0);
  });

  it('has row level security enabled, like every other table', async () => {
    const { rows } = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='circuit_breaker_events'`);
    expect((rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(true);
  });
});
