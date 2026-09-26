-- ZeroPoint initial schema. Source: SRS section 4.3 (verbatim).

CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    default_budget_usd NUMERIC(12,4) NOT NULL DEFAULT 20.0000,
    velocity_limit_usd NUMERIC(12,4) NOT NULL DEFAULT 2.0000,
    velocity_window_seconds INTEGER NOT NULL DEFAULT 60,
    circuit_breaker_duration_seconds INTEGER NOT NULL DEFAULT 900,
    webhook_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE end_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    external_user_id TEXT NOT NULL,
    budget_limit_usd NUMERIC(12,4),
    current_spend_usd NUMERIC(12,4) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','blocked','suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, external_user_id)
);

CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_hash CHAR(64) NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','revoked')),
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    UNIQUE (key_hash)
);

CREATE TABLE request_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL UNIQUE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    end_user_id UUID REFERENCES end_users(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT,
    status_code INTEGER,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    estimated_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
    usage_source TEXT CHECK (
        usage_source IN ('provider_reported','estimated','unknown')
    ),
    latency_ms INTEGER,
    streaming BOOLEAN NOT NULL DEFAULT FALSE,
    circuit_breaker_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    circuit_breaker_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_end_users_tenant ON end_users(tenant_id);
CREATE INDEX idx_request_logs_tenant_created
ON request_logs(tenant_id, created_at DESC);
CREATE INDEX idx_request_logs_user_created
ON request_logs(end_user_id, created_at DESC);
CREATE INDEX idx_request_logs_provider ON request_logs(provider);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
