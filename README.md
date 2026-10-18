# AutoDev

Multi-tenant B2B SaaS: developers hand coding tasks to an AI agent that plans, designs, codes,
tests on the developer's own machine, and opens a GitHub PR **as the developer**.

**Status:** Section A, phase A-1 (monorepo, schema, GitHub App sign-in, orgs and roles,
write-access repo list).

## Layout

```
apps/web              Next.js 15 (App Router, Tailwind, shadcn/ui, TanStack Query, tRPC client)
apps/api              Fastify: tRPC for the web app, REST for webhooks / GitHub setup (and the builder later)
apps/worker           BullMQ workers (repo-sync now; agent, stale-branch, key-validation later)
apps/builder-gateway  WebSocket gateway for local builders (A-5)
apps/runner-cli       autodev-runner CLI (A-5)
packages/config       Zod env schemas, queue contracts
packages/crypto       AES-256-GCM envelope encryption, KMS-wrapped data keys
packages/db           Drizzle schema, migrations, RLS, withOrg(), seed
packages/github       Octokit clients, token vault, repo access cache, webhooks, login
packages/ui           shadcn-style components + Tailwind preset
packages/{llm,agent,protocol}   later phases
tools/mock-github     Fake GitHub for e2e tests
tools/e2e             Playwright
```

## Quick start

Requires **Node 22** (18.18+ works for now), **pnpm 9** and Docker with Compose v2.

```bash
cp .env.example .env
# fill MASTER_KEY and AUTH_SECRET:
#   openssl rand -base64 32   -> MASTER_KEY
#   openssl rand -base64 48   -> AUTH_SECRET
# then the GITHUB_* values (see docs/github-app.md)

docker compose up -d          # Postgres 16 + pgvector on :5433, Redis on :6379
pnpm install
pnpm db:migrate
pnpm db:seed                  # optional demo org "acme-demo"
pnpm dev                      # web :3000, api :4000, worker
```

MinIO is opt-in (`docker compose --profile s3 up -d`). Its public images are no longer pullable
anonymously, and S3 isn't needed until phase A-4.

## Tests

```bash
pnpm test                      # Vitest: unit + DB integration (uses the autodev_test database)
pnpm --filter @autodev/e2e e2e # Playwright against tools/mock-github (needs docker compose up)
```

GitHub and LLM calls are always mocked in tests (msw for unit tests, mock-github for e2e).

## Security model (A-1)

- **Tenancy:** every tenant table has `org_id` with Postgres RLS. Request paths use the
  `autodev_app` role, which has no BYPASSRLS. A missing org context returns nothing.
  `autodev_system` (BYPASSRLS) is used only for migrations, sign-in, webhooks and background jobs.
- **Tokens:** GitHub user tokens are envelope-encrypted (a data key per row, wrapped by the KMS
  master key). The app role can't read `github_tokens`, and tokens never go into the session JWT
  or the browser.
- **Repo access:** the list shows only repos where the user has push, maintain or admin,
  cached 15 minutes and invalidated by webhooks. Pushes and PRs always re-check permission live.
- **Webhooks:** HMAC SHA-256 is verified over the raw body, and deliveries are deduplicated.
  Webhooks only invalidate caches; they never grant access.
- **Audit:** `audit_log` is append-only (grants plus a trigger). Sign-ins, role and settings
  changes, and installations are recorded.

See [docs/schema.md](docs/schema.md) and [docs/github-app.md](docs/github-app.md).
