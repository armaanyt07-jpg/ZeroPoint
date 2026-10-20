-- Phase 4 (FR-4.1 / FR-4.2, SRS section 12): administrative dashboard.
-- Not in SRS 4.3 verbatim; additive, so 001 stays identical to the SRS.

-- 1. Admin allowlist (docs/PHASE_4_PLAN.md D1). Supabase Auth proves who someone
--    is; this table decides whether they may use the dashboard. Keyed by email
--    (lowercase) rather than auth.users.id so an admin can be allowlisted before
--    their first sign-in, and so this file also runs on plain PostgreSQL (tests),
--    where the auth schema does not exist.
CREATE TABLE admins (
    email TEXT PRIMARY KEY CHECK (email = lower(email) AND position('@' IN email) > 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Model prices (D3/D9), entered by administrators, read by the Worker. Global,
--    not per tenant. A request's cost is frozen into request_logs when it is
--    settled, so editing a price here never rewrites history (SRS 18, "versioned
--    pricing configuration").
CREATE TABLE model_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider <> ''),
    model TEXT NOT NULL CHECK (model <> ''),
    input_per_million_usd NUMERIC(12,6) NOT NULL CHECK (input_per_million_usd >= 0),
    output_per_million_usd NUMERIC(12,6) NOT NULL CHECK (output_per_million_usd >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, model)
);

-- Least privilege, matching migration 003: RLS on, no policies, service-role only.
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;

-- 3. Dashboard aggregates (D10). PostgREST cannot GROUP BY, so each panel is one
--    function. All take the tenant and the start of the range; days are UTC.

-- TOTAL SPEND / ACTIVE USERS / CIRCUITS OPEN plus request and token totals.
-- open_circuits counts users whose most recent trip has not expired yet; it reads
-- the best-effort audit trail (docs/PHASE_3.md), so it can under-count.
CREATE OR REPLACE FUNCTION dashboard_summary(p_tenant_id UUID, p_since TIMESTAMPTZ)
RETURNS TABLE (
    total_spend_usd NUMERIC,
    request_count BIGINT,
    input_tokens BIGINT,
    output_tokens BIGINT,
    total_tokens BIGINT,
    active_users BIGINT,
    open_circuits BIGINT
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
    SELECT
        COALESCE(SUM(r.estimated_cost_usd), 0),
        COUNT(*),
        COALESCE(SUM(r.input_tokens), 0)::BIGINT,
        COALESCE(SUM(r.output_tokens), 0)::BIGINT,
        COALESCE(SUM(r.total_tokens), 0)::BIGINT,
        COUNT(DISTINCT r.end_user_id),
        (SELECT COUNT(DISTINCT c.external_user_id)
           FROM circuit_breaker_events c
          WHERE c.tenant_id = p_tenant_id AND c.expires_at > NOW())
    FROM request_logs r
    WHERE r.tenant_id = p_tenant_id AND r.created_at >= p_since;
$$;

-- DAILY SPEND, one row per UTC day from p_since to today, zero-filled so the
-- chart has no gaps.
CREATE OR REPLACE FUNCTION dashboard_daily_spend(p_tenant_id UUID, p_since TIMESTAMPTZ)
RETURNS TABLE (day DATE, spend_usd NUMERIC, request_count BIGINT, total_tokens BIGINT)
LANGUAGE sql STABLE
SET search_path = public
AS $$
    SELECT
        d.day::DATE,
        COALESCE(SUM(r.estimated_cost_usd), 0),
        COUNT(r.id),
        COALESCE(SUM(r.total_tokens), 0)::BIGINT
    FROM generate_series(
        (p_since AT TIME ZONE 'UTC')::DATE,
        (NOW() AT TIME ZONE 'UTC')::DATE,
        INTERVAL '1 day'
    ) AS d(day)
    LEFT JOIN request_logs r
        ON r.tenant_id = p_tenant_id
       AND r.created_at >= p_since
       AND (r.created_at AT TIME ZONE 'UTC')::DATE = d.day::DATE
    GROUP BY d.day
    ORDER BY d.day;
$$;

-- SPEND / USER and TOP SPENDERS (same data; the page takes the first rows).
CREATE OR REPLACE FUNCTION dashboard_top_spenders(p_tenant_id UUID, p_since TIMESTAMPTZ, p_limit INTEGER)
RETURNS TABLE (external_user_id TEXT, spend_usd NUMERIC, request_count BIGINT, total_tokens BIGINT)
LANGUAGE sql STABLE
SET search_path = public
AS $$
    SELECT
        u.external_user_id,
        SUM(r.estimated_cost_usd),
        COUNT(*),
        COALESCE(SUM(r.total_tokens), 0)::BIGINT
    FROM request_logs r
    JOIN end_users u ON u.id = r.end_user_id
    WHERE r.tenant_id = p_tenant_id AND r.created_at >= p_since
    GROUP BY u.external_user_id
    ORDER BY 2 DESC, 3 DESC, 1
    LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

-- Operations page (D12): models that were used but had no price, so their
-- requests were recorded at $0 (usage_source 'unknown').
CREATE OR REPLACE FUNCTION dashboard_unpriced_models(p_tenant_id UUID, p_since TIMESTAMPTZ)
RETURNS TABLE (provider TEXT, model TEXT, request_count BIGINT, last_seen TIMESTAMPTZ)
LANGUAGE sql STABLE
SET search_path = public
AS $$
    SELECT r.provider, r.model, COUNT(*), MAX(r.created_at)
    FROM request_logs r
    WHERE r.tenant_id = p_tenant_id
      AND r.created_at >= p_since
      AND r.usage_source = 'unknown'
      AND r.model IS NOT NULL
    GROUP BY r.provider, r.model
    ORDER BY 3 DESC, 1, 2;
$$;

-- 4. Same lock-down as settle_usage (migration 005): functions are executable by
--    PUBLIC by default and Supabase exposes them at /rest/v1/rpc/... to the anon
--    key. Only service_role (the dashboard server) may call them.
REVOKE ALL ON FUNCTION dashboard_summary(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION dashboard_daily_spend(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION dashboard_top_spenders(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION dashboard_unpriced_models(UUID, TIMESTAMPTZ) FROM PUBLIC;
DO $$
DECLARE
    fn TEXT;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'dashboard_summary(UUID, TIMESTAMPTZ)',
        'dashboard_daily_spend(UUID, TIMESTAMPTZ)',
        'dashboard_top_spenders(UUID, TIMESTAMPTZ, INTEGER)',
        'dashboard_unpriced_models(UUID, TIMESTAMPTZ)'
    ] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
        END IF;
    END LOOP;
END
$$;
