-- DECISION (not in SRS 4.3): NFR-5.2 requires provider credentials to be
-- AES-256-GCM encrypted at rest, but the SRS schema has nowhere to store them.
-- encrypted_api_key holds "v1:<iv>:<ciphertext>" produced by packages/crypto.
-- The plaintext key and the encryption key are never stored in the database.

CREATE TABLE tenant_provider_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, provider)
);

CREATE INDEX idx_tenant_provider_credentials_tenant
ON tenant_provider_credentials(tenant_id);
