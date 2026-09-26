# ZeroPoint

Edge AI Gateway & Cost Governance Proxy. See `docs/ZeroPoint_SRS_v1.0.pdf` (source of truth) and `docs/PHASE_1.md`.

**Status: Phase 1** - authenticated edge proxy with pre-flight budget guardrails (OpenAI only).

## Requirements
Node 20+ and pnpm.

## Commands
```
pnpm install
pnpm check          # typecheck + lint + tests
pnpm test
pnpm build:check    # bundle the Worker without deploying
pnpm dev            # wrangler dev (needs apps/worker/.dev.vars)
```

## Running locally
1. Create a Supabase project and apply `database/migrations/*.sql` in order.
2. Create an Upstash Redis database.
3. `cp apps/worker/.dev.vars.example apps/worker/.dev.vars` and fill it in (git-ignored).
4. Seed a tenant, then use `pnpm helper` to make a proxy key hash (`generate-proxy-key`) and an encrypted provider key (`encrypt-credential`), and insert them into `api_keys` / `tenant_provider_credentials`.
5. `pnpm dev`, then:
```
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer pk_live_..." -H "x-user-id: user_123" -H "x-provider: openai" \
  -H "Content-Type: application/json" -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```
Never commit `.dev.vars` or any real key.
