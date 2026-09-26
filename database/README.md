# Database migrations

Plain SQL, applied in filename order to Supabase PostgreSQL (SQL editor or `psql`).

| File | Purpose |
| --- | --- |
| `001_init.sql` | SRS section 4.3 schema, verbatim |
| `002_tenant_provider_credentials.sql` | Encrypted provider keys (NFR-5.2) - **decision, not in SRS** |
| `003_enable_row_level_security.sql` | Deny public API access; only the service-role key can read |
