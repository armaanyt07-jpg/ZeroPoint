-- Phase 3 (FR-3.4 "record the event"): audit trail for circuit-breaker trips.
-- Not in SRS 4.3 verbatim; additive, like migrations 002/005, so 001 stays
-- identical to the SRS. Read by the Phase 4 dashboard ("CIRCUIT BREAKER EVENTS",
-- SRS section 12 "View circuit-breaker events").
--
-- external_user_id is denormalized (TEXT, not a foreign key into end_users):
-- a loop can be detected for a user who has never had a request settled yet
-- (settlement is asynchronous, Phase 2), so an end_users row may not exist.

CREATE TABLE circuit_breaker_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    external_user_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('velocity', 'loop')),
    opened_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Whether the webhook itself was delivered is observable via telemetry/logs
-- (circuit_breaker_events metric, webhook_event_lost log line), not this table:
-- there is no shared id between a trip and its queued notification to join on.

CREATE INDEX idx_circuit_breaker_events_tenant_created
ON circuit_breaker_events(tenant_id, created_at DESC);

CREATE INDEX idx_circuit_breaker_events_user
ON circuit_breaker_events(tenant_id, external_user_id, created_at DESC);

-- Least privilege, matching migration 003: RLS on, no policies, service-role only.
ALTER TABLE circuit_breaker_events ENABLE ROW LEVEL SECURITY;
