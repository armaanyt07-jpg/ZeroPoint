-- Least privilege (NFR-5.2). Supabase exposes every public table through its
-- REST API to the public "anon" key. Enabling RLS with NO policies denies all
-- access to anon/authenticated roles. Only the service-role key (held solely as
-- a Worker secret) bypasses RLS.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE end_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_provider_credentials ENABLE ROW LEVEL SECURITY;
