-- Phase 2 (FR-2.3 / FR-2.4): durable, idempotent usage settlement.
-- Not in SRS 4.3 verbatim; additive, so 001 stays identical to the SRS.

-- 1. Precision. Costs are tiny (a typical request is ~$0.00003) but the SRS
--    schema stores end_users.current_spend_usd as NUMERIC(12,4): adding each cost
--    to a 4-decimal column would round it and silently under-count. Widen it to
--    the precision of request_logs.estimated_cost_usd.
ALTER TABLE end_users
    ALTER COLUMN current_spend_usd TYPE NUMERIC(14,8);

-- 2. settle_usage: one transaction that (a) makes sure the end user exists,
--    (b) inserts the request log, and (c) adds the cost to the user's spend ONLY
--    if the log row was newly inserted. request_logs.request_id is UNIQUE, so a
--    queue redelivery (or two consumers racing on the same message) inserts
--    nothing and adds nothing. Returns true if this call settled the request.
CREATE OR REPLACE FUNCTION settle_usage(
    p_request_id UUID,
    p_tenant_id UUID,
    p_external_user_id TEXT,
    p_provider TEXT,
    p_model TEXT,
    p_status_code INTEGER,
    p_input_tokens BIGINT,
    p_output_tokens BIGINT,
    p_total_tokens BIGINT,
    p_estimated_cost_usd NUMERIC,
    p_usage_source TEXT,
    p_latency_ms INTEGER,
    p_streaming BOOLEAN,
    p_created_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_inserted INTEGER;
BEGIN
    -- Phase 1 never created end_users rows; settlement does (docs/PHASE_1.md).
    INSERT INTO end_users (tenant_id, external_user_id)
    VALUES (p_tenant_id, p_external_user_id)
    ON CONFLICT (tenant_id, external_user_id) DO NOTHING;

    SELECT id INTO v_user_id
    FROM end_users
    WHERE tenant_id = p_tenant_id AND external_user_id = p_external_user_id;

    INSERT INTO request_logs (
        request_id, tenant_id, end_user_id, provider, model, status_code,
        input_tokens, output_tokens, total_tokens, estimated_cost_usd,
        usage_source, latency_ms, streaming, created_at
    ) VALUES (
        p_request_id, p_tenant_id, v_user_id, p_provider, p_model, p_status_code,
        p_input_tokens, p_output_tokens, p_total_tokens, p_estimated_cost_usd,
        p_usage_source, p_latency_ms, p_streaming, COALESCE(p_created_at, NOW())
    )
    ON CONFLICT (request_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
        RETURN FALSE; -- already settled: never count twice
    END IF;

    UPDATE end_users
    SET current_spend_usd = current_spend_usd + p_estimated_cost_usd,
        updated_at = NOW()
    WHERE id = v_user_id;
    RETURN TRUE;
END;
$$;

-- 3. Functions are executable by PUBLIC by default, and Supabase exposes them as
--    /rest/v1/rpc/... to the public anon key; RLS does not protect them. Only the
--    service-role key (a Worker secret) may call settle_usage. The role checks let
--    the same file run on plain PostgreSQL (tests), where these roles don't exist.
REVOKE ALL ON FUNCTION settle_usage(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, BIGINT, BIGINT, BIGINT, NUMERIC, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION settle_usage(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, BIGINT, BIGINT, BIGINT, NUMERIC, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ) FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION settle_usage(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, BIGINT, BIGINT, BIGINT, NUMERIC, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ) FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION settle_usage(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, BIGINT, BIGINT, BIGINT, NUMERIC, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ) TO service_role;
    END IF;
END
$$;
