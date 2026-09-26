-- Defense in depth: a negative budget is never meaningful. With `spend >= limit`
-- a negative limit would block every request for that user or tenant.
-- The SRS 4.3 schema has no such constraint; this is an addition (docs/PHASE_1.md).
--
-- Added as a new migration rather than editing 001 so 001 stays identical to the
-- SRS and databases that already applied it can still upgrade.
-- NOTE: fails if existing rows already hold negative budgets; fix those first.
-- end_users.budget_limit_usd may be NULL (= use the tenant default); a NULL
-- satisfies a CHECK constraint, so no explicit IS NULL branch is needed.

ALTER TABLE tenants
    ADD CONSTRAINT tenants_default_budget_non_negative
    CHECK (default_budget_usd >= 0);

ALTER TABLE end_users
    ADD CONSTRAINT end_users_budget_limit_non_negative
    CHECK (budget_limit_usd >= 0);
