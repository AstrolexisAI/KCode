# kcode/backend — Reference Bun + Hono + SQLite backend

This is a **self-hosted reference implementation** of the OAuth +
subscriptions backend that kcode CLI's `/login` flow expects.

It works, and it's the cleanest way to run the whole stack on a
single VPS. **But the production deployment lives elsewhere**:

## Production: `~/astrolexis-site`

The real astrolexis.space backend is a Cloudflare Pages deployment
with D1 (managed SQLite). The layout mirrors this one but uses
Pages Functions instead of Hono, and D1 bindings instead of
`bun:sqlite`.

- Repo: `~/astrolexis-site/`
- Deploy guide: `~/astrolexis-site/DEPLOY.md`
- Functions: `~/astrolexis-site/functions/**`
- Schema: `~/astrolexis-site/schema.sql`

## When to use THIS Bun backend instead

- You want to self-host the entire stack (VPS, on-prem, air-gapped
  customer deployments) without depending on Cloudflare
- You want a single-binary deployment (Bun builds it all into one
  executable)
- You're iterating on the OAuth logic locally and want faster
  rebuild/test cycles than `wrangler pages dev`

## What's here

| File                | Purpose                                                  |
|---------------------|----------------------------------------------------------|
| `src/db.ts`         | SQLite schema (users, sessions, oauth_*, customers, etc.) |
| `src/oauth.ts`      | PKCE authorize / consent / token / Bearer middleware      |
| `src/pages.ts`      | Server-rendered HTML (login, signup, dashboard, consent)  |
| `src/index.ts`      | Hono app wiring all endpoints + Stripe webhook            |
| `src/email.ts`      | Resend integration (pro key / welcome / password reset)   |
| `src/stripe.ts`     | Stripe Checkout + Portal + signature verification         |
| `src/keys.ts`       | Legacy `kcode_pro_*` key generation (pre-OAuth migration) |

Same endpoint contract as `~/astrolexis-site`:
`/oauth/authorize`, `/oauth/token`, `/api/subscription`.

## Run locally

```bash
cd backend
bun install
DB_PATH=./data/kcode.db bun run src/index.ts
# Listens on 0.0.0.0:10080
```

Tests:
```bash
bun test
# 57 tests (schema + OAuth flow + bearer auth + Stripe mock)
```
