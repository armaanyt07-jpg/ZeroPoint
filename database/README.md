# Database migrations

Plain SQL, applied in filename order to Supabase PostgreSQL (SQL editor or `psql`).

| File | Purpose |
| --- | --- |
| `001_init.sql` | SRS section 4.3 schema, verbatim |
| `002_tenant_provider_credentials.sql` | Encrypted provider keys (NFR-5.2) - **decision, not in SRS** |
| `003_enable_row_level_security.sql` | Deny public API access; only the service-role key can read |
| `004_budget_non_negative_checks.sql` | `CHECK (budget >= 0)` on tenant and per-user budgets - **addition, not in SRS** |
| `005_settlement.sql` | Phase 2: widens `end_users.current_spend_usd` to `NUMERIC(14,8)` and adds the idempotent `settle_usage()` function (service-role only) - **addition, not in SRS** |
| `006_circuit_breaker.sql` | Phase 3: `circuit_breaker_events` audit table (FR-3.4 "record the event") - **addition, not in SRS** |
| `007_dashboard.sql` | Phase 4: `admins` allowlist, `model_prices`, and the `dashboard_*` aggregate functions (service-role only) - **addition, not in SRS** |
