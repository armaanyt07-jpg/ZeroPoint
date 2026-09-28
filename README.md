# ZeroPoint

Edge AI Gateway & Cost Governance Proxy. See `docs/ZeroPoint_SRS_v1.0.pdf` (source of truth), `docs/PHASE_1.md` and `docs/PHASE_2.md`.

**Status: Phase 2** - authenticated edge proxy with pre-flight budget guardrails (OpenAI, Anthropic, Gemini), plus `tee()` stream inspection and asynchronous, idempotent usage settlement through Cloudflare Queues into Redis and PostgreSQL. Spend only accumulates once model prices are configured (`packages/pricing`; the SRS lists none).

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
1. Create a Supabase project and apply `database/migrations/*.sql` in order (001-005).
2. Create an Upstash Redis database, and the queues: `wrangler queues create zeropoint-usage` and `wrangler queues create zeropoint-usage-dlq`.
3. `cp apps/worker/.dev.vars.example apps/worker/.dev.vars` and fill it in (git-ignored).
4. Seed a tenant, then use `pnpm helper` to make a proxy key hash (`generate-proxy-key`) and an encrypted provider key (`encrypt-credential`), and insert them into `api_keys` / `tenant_provider_credentials`.
5. `pnpm dev`, then:
```
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer pk_live_..." -H "x-user-id: user_123" -H "x-provider: openai" \
  -H "Content-Type: application/json" -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```
`GET /health` reports readiness (503 if secrets are missing). Every proxy response carries an `x-request-id` header; quote it when reporting a problem.

Anthropic: `POST /v1/messages` with `x-provider: anthropic`. Gemini: `POST /v1beta/models/<model>:generateContent` with `x-provider: gemini`. All use `Authorization: Bearer <proxy key>`; the tenant needs an encrypted key row for each provider it uses.

Never commit `.dev.vars` or any real key.
