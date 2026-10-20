# ZeroPoint

Edge AI Gateway & Cost Governance Proxy. See `docs/ZeroPoint_SRS_v1.0.pdf` (source of truth), `docs/PHASE_1.md`, `docs/PHASE_2.md`, `docs/PHASE_3.md` and `docs/PHASE_4.md`.

**Status: Phase 4.** What's built:
- An authenticated edge proxy for OpenAI, Anthropic and Gemini that checks budgets before calling the provider.
- `tee()` stream inspection, with asynchronous, idempotent usage settlement through Cloudflare Queues into Redis and PostgreSQL.
- A runaway-agent-loop circuit breaker: a sliding-window spend check, SHA-256 loop detection, and queued webhooks.
- A Next.js admin dashboard (`apps/dashboard`) for:
  - tenants and their policy
  - proxy keys (shown once)
  - provider credentials
  - end-user budgets
  - model prices
  - spend, token and circuit-breaker analytics

Spend only accumulates once model prices are entered on the dashboard's **Model prices** page; the SRS lists none.

## Requirements
Node 20+ and pnpm.

## Commands
```
pnpm install
pnpm check            # typecheck + lint + tests (Worker and dashboard)
pnpm test
pnpm build:check      # bundle the Worker without deploying
pnpm dev              # wrangler dev (needs apps/worker/.dev.vars)
pnpm dashboard        # next dev for the dashboard (needs apps/dashboard/.env.local)
pnpm dashboard:build  # production build of the dashboard
```

## Running locally
1. Create a Supabase project and apply `database/migrations/*.sql` in order (001-007).
2. Create an Upstash Redis database and the four queues: `wrangler queues create` for `zeropoint-usage`, `zeropoint-usage-dlq`, `zeropoint-webhooks` and `zeropoint-webhooks-dlq`.
3. Generate one encryption key with `pnpm helper gen-encryption-key`. The Worker and the dashboard must use the same value.
4. Worker: `cp apps/worker/.dev.vars.example apps/worker/.dev.vars` and fill it in (git-ignored).
5. Dashboard: `cp apps/dashboard/.env.example apps/dashboard/.env.local` and fill it in (git-ignored).
6. Allow yourself into the dashboard: run the SQL printed by `pnpm helper add-admin you@company.com` in the Supabase SQL editor.
7. In Supabase Auth, add `http://localhost:3000/auth/callback` (and your production URL) to the redirect URLs.
8. `pnpm dashboard`, then open http://localhost:3000 and sign in with the emailed link. Then:
   1. Create a tenant.
   2. Add a provider credential.
   3. Add model prices.
   4. Generate a proxy key.
9. `pnpm dev`, then:
```
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer pk_live_..." -H "x-user-id: user_123" -H "x-provider: openai" \
  -H "Content-Type: application/json" -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```
`GET /health` reports readiness (503 if secrets are missing). Every proxy response carries an `x-request-id` header; quote it when reporting a problem.

Anthropic: `POST /v1/messages` with `x-provider: anthropic`. Gemini: `POST /v1beta/models/<model>:generateContent` with `x-provider: gemini`. All use `Authorization: Bearer <proxy key>`. The tenant needs a credential for each provider it uses.

## Deploying the dashboard (Vercel)
Create a Vercel project with **Root Directory** `apps/dashboard` (framework: Next.js). Set the variables from `apps/dashboard/.env.example` in the project settings, including `DASHBOARD_URL`. Add `<DASHBOARD_URL>/auth/callback` to Supabase Auth's redirect URLs.

Never commit `.dev.vars`, `.env.local` or any real key.
