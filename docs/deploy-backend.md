# Deploying the backend

The web app runs on Vercel (see [deploy-vercel.md](deploy-vercel.md)) or anywhere Next.js runs. Everything
else is one Docker image:

| Service | What it does | Public? | Command |
|---|---|---|---|
| **api** | tRPC for the web app, the event stream, GitHub webhooks, builder pairing | Yes, HTTPS | `AUTODEV_SERVICE=api` |
| **worker** | Agent runs, chat answers, code index, nightly jobs (insights, Group Agent, stale branches) | No | `AUTODEV_SERVICE=worker` |
| **gateway** | Builders' WebSocket connections | Yes, WSS | `AUTODEV_SERVICE=gateway` |
| **migrate** | Database migrations, then exits | — | `AUTODEV_SERVICE=migrate` (or `docker run … autodev migrate`) |

Plus **Postgres 16 with pgvector** and **Redis 7**.

```
docker build -t autodev .                       # the backend image (any service)
docker build --target web -t autodev-web .       # the web app, only if you don't use Vercel
```

The image is about 1.9 GB (it carries every workspace dependency). Slimming it is a known follow-up.

## 1. Postgres

AutoDev uses two roles: `autodev_system` (owns the schema, runs migrations, webhooks and cross-org jobs,
needs **BYPASSRLS**) and `autodev_app` (every request, always under row-level security).

- **Managed Postgres:** run [docker/postgres/init-hosted.sql](../docker/postgres/init-hosted.sql) once as the
  provider's admin user:
  `psql "$ADMIN_URL" -v system_password='…' -v app_password='…' -f docker/postgres/init-hosted.sql`.
  The provider must let its admin user create a role with `BYPASSRLS` and offer the `vector`
  extension. Not every managed service allows `BYPASSRLS`; check before choosing one (the script fails
  on the first line if it isn't allowed). A Postgres you run yourself always works.
- **Your own machine:** `docker-compose.prod.yml` does it on first start.

Then `DATABASE_URL` uses `autodev_app` and `DATABASE_URL_SYSTEM` uses `autodev_system`. Run migrations
(`AUTODEV_SERVICE=migrate`) before the first start and on every deploy.

## 2. Settings

Generate secrets once and give the same values to every service that needs them:
`MASTER_KEY=$(openssl rand -base64 32)`, `AUTH_SECRET=$(openssl rand -base64 48)`.

| Variable | api | worker | gateway | web | Notes |
|---|:-:|:-:|:-:|:-:|---|
| `DATABASE_URL` | ✓ | ✓ | ✓ |  | `autodev_app` |
| `DATABASE_URL_SYSTEM` | ✓ | ✓ | ✓ | ✓ | `autodev_system`; pooled URL for the web app |
| `REDIS_URL` | ✓ | ✓ | ✓ |  | |
| `MASTER_KEY`, `MASTER_KEY_ID` | ✓ | ✓ |  | ✓ | Encrypts tokens and keys. Losing it loses them |
| `AUTH_SECRET` | ✓ |  |  | ✓ | Same value on both |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | ✓ | ✓ |  | ✓ | |
| `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | ✓ | ✓ |  |  | Never on the web app |
| `WEB_URL` | ✓ | ✓ |  | ✓ | The web app's public address (links in PRs and notifications) |
| `API_URL` |  |  |  | ✓ | The API's address, read at build time |
| `NEXT_PUBLIC_API_URL` |  |  |  | ✓ | Shown in builder pairing commands |
| `BUILDER_GATEWAY_URL` | ✓ |  |  |  | `wss://<gateway>/builder`, handed to builders at pairing |
| `BLOB_DRIVER`, `S3_*` | ✓ | ✓ | ✓ |  | Optional: `s3` stores logs and patches in S3 instead of Postgres |
| `EMBEDDINGS_CACHE_DIR` |  | ✓ |  |  | Defaults to `/var/cache/autodev/embeddings`; mount a volume there |
| `OSV_API_URL`, `NPM_REGISTRY_URL`, `PYPI_URL`, `GOPROXY_URL` |  | ✓ |  |  | Optional overrides for the Group Agent |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS` | ✓ | ✓ |  |  | Optional: billing is off without the key. Never on the web app |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_WEBHOOK_SECRET` | ✓ |  |  |  | Optional: single sign-on and directory sync. Off without the key and client id |
| `DATA_REGION` | ✓ | ✓ |  |  | This deployment's region (default `us`). New orgs are created in it; orgs from another region are refused |
| `TRUST_PROXY` | ✓ |  |  |  | How many proxies sit in front of the API (e.g. `1`). The client address in the audit log and IP allowlists comes from `X-Forwarded-For`; the default `true` believes every hop, which is only safe when nothing can reach the API directly |
| `OUTBOUND_ALLOW_PRIVATE` | ✓ | ✓ |  |  | `1` lets SIEM endpoints be `http://` or private addresses. Development only |
| `TRIAL_DAYS` | ✓ | ✓ |  |  | Free trial from the org's creation, default 14 |
| `NEXT_PUBLIC_SALES_URL` |  |  |  | ✓ | Optional link on the Enterprise plan card |
| `PORT` | ✓ |  | ✓ |  | Set by most hosts; the gateway also reads `GATEWAY_PORT` |
| `MIGRATE_ON_START` | ✓ |  |  |  | `1` runs migrations before the API starts, for hosts without a release step |
| `NODE_ENV` | ✓ | ✓ | ✓ | ✓ | `production` |

The worker needs about 1–2 GB of memory when the code index is on (the embedding model runs in-process).

## 3a. Railway

Create one project with Postgres (from a template that allows `BYPASSRLS`, or an external database) and
Redis, then three services from this repository:

| Service | Config file path | Variables |
|---|---|---|
| api | `deploy/railway/api.json` | `AUTODEV_SERVICE=api`, `MIGRATE_ON_START=1`, and the settings above |
| worker | `deploy/railway/worker.json` | `AUTODEV_SERVICE=worker`; add a volume at `/var/cache/autodev/embeddings` |
| gateway | `deploy/railway/gateway.json` | `AUTODEV_SERVICE=gateway` |

Give api and gateway public domains. Railway sets `PORT`.

## 3b. Fly.io

From the repository root, once per app (create them first with `fly apps create`):

```
fly secrets set --config deploy/fly/api.toml DATABASE_URL=… DATABASE_URL_SYSTEM=… …
fly deploy --config deploy/fly/api.toml --dockerfile Dockerfile
fly volumes create embeddings --size 1 --config deploy/fly/worker.toml
fly deploy --config deploy/fly/worker.toml --dockerfile Dockerfile
fly deploy --config deploy/fly/gateway.toml --dockerfile Dockerfile
```

The api app runs migrations as its release command. Change the app names in the three files first.

## 3c. One machine (Docker Compose)

```
cp .env.example .env.production          # fill in the settings above (no DATABASE_URL*: compose sets them)
export POSTGRES_ADMIN_PASSWORD=… AUTODEV_SYSTEM_PASSWORD=… AUTODEV_APP_PASSWORD=…
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

This runs Postgres, Redis, migrations, api (4000), worker, gateway (4100) and web (3000). Put a TLS
proxy (Caddy, nginx, a load balancer) in front of web, api and gateway. Postgres and Redis aren't
exposed.

## 4. GitHub App

- **Callback URL** `{WEB_URL}/api/auth/callback/github`, **Setup URL** `{WEB_URL}/api/github/setup`.
- **Webhook URL** `{API}/webhooks/github` with the secret in `GITHUB_WEBHOOK_SECRET`.
- Events: see [github-app.md](github-app.md) (including **Push**, for the code index).

## 5. Stripe (optional)

1. Create two **recurring, per-unit** prices (Team and Business) and put their ids in `STRIPE_PRICE_*`.
2. Add a webhook endpoint `{API}/webhooks/stripe` with the events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and
   `invoice.payment_failed`; its signing secret goes in `STRIPE_WEBHOOK_SECRET`.
3. Turn on the **customer portal** in Stripe (plan changes, cancellation, payment methods).

Seats follow active members nightly (02:45 UTC) and when someone is removed. Enterprise plans are set
by hand: insert a `subscriptions` row with `plan = 'enterprise'`.

## 6. WorkOS (optional: single sign-on and directory sync)

1. In WorkOS, add the redirect URI `{WEB_URL}/api/sso/callback`.
2. Add a webhook endpoint `{API}/webhooks/workos` with the `dsync.*` events; its secret goes in
   `WORKOS_WEBHOOK_SECRET`.
3. Each customer's admin then uses **Settings → Security → Connect an identity provider**, which opens
   WorkOS's setup portal for their IdP (Okta, Entra ID, Google Workspace…).

## 7. Check it

1. `GET {API}/healthz` and `GET {GATEWAY}/healthz` return `{"ok":true}`.
2. The web app's `/login` shows **Continue with GitHub** (not **Setup needed**).
3. Sign in, then **Settings → AI keys**: add a key; the API checks it.
4. Pair a builder from **Builders**; it should show as online.
