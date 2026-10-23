# Deploying the web app on Vercel

Vercel hosts **only `apps/web`** (Next.js). The rest of AutoDev runs elsewhere (one Docker image, see
[deploy-backend.md](deploy-backend.md)), and the web app needs all of it:

| Piece | Where | Notes |
|---|---|---|
| `apps/web` | Vercel | This guide |
| `apps/api` | Any Node host with a public HTTPS URL (Railway, Fly.io, Render, a VM) | Long-lived process: Fastify, the event stream, webhooks |
| `apps/worker` | Same kind of host as the API | BullMQ workers; no public port |
| `apps/builder-gateway` | Same kind of host, public `wss://` URL | Developers' runners connect here |
| Postgres 16 + pgvector | Neon, Supabase, RDS… | Run `pnpm db:migrate` against it once |
| Redis | Upstash, Redis Cloud… | Used by the API, worker and gateway |

The browser only ever talks to the Vercel domain: `next.config.ts` proxies `/api/trpc`,
`/api/github` and `/api/events` to `API_URL`, so the session cookie stays first-party and the API
needs no CORS.

## 1. Create the project

1. In Vercel, **Add New → Project** and import the GitHub repo.
2. **Root Directory:** `apps/web`. Leave **Include files outside the root directory** on (the app
   imports workspace packages from `packages/`).
3. Framework, install and build commands come from `apps/web/vercel.json`
   (`pnpm install --frozen-lockfile`, `pnpm --filter @autodev/web build`). pnpm's version comes
   from `packageManager` in the root `package.json`.

`next build` needs no secrets: every variable below is read at runtime.

Or from a terminal: `npm i -g vercel`, then in the repo root `vercel link` (choose `apps/web` as the
root directory) and `vercel deploy --prod`.

## 2. Environment variables (Production, and Preview if you use previews)

| Variable | Value | Secret? |
|---|---|---|
| `WEB_URL` | The Vercel URL, e.g. `https://autodev.example.com` | no |
| `API_URL` | The API's public URL, e.g. `https://api.autodev.example.com` | no |
| `NEXT_PUBLIC_API_URL` | Same as `API_URL` (shown in the builder pairing commands) | no |
| `AUTH_SECRET` | `openssl rand -base64 48`, **the same value as the API's** | yes |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG` | From the GitHub App | no |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | From the GitHub App | secret: yes |
| `DATABASE_URL_SYSTEM` | The `autodev_system` role's URL, **pooled** (e.g. Neon's `-pooler` host) | yes |
| `MASTER_KEY`, `MASTER_KEY_ID` | **The same values as the API's** | yes |
| `NODE_ENV` | `production` | no |

Why the database and master key: sign-in happens in the web app, which encrypts the user's GitHub
tokens and stores them (`github_tokens`). Nothing else in the web app touches the database. The
GitHub App **private key and webhook secret are not needed here** and should not be added; they
stay with the API and worker.

Serverless functions open a connection per instance, so use a pooled URL for
`DATABASE_URL_SYSTEM` (the app keeps at most 3 connections per instance).

## 3. Point GitHub and the backend at the new domain

- GitHub App settings: **Callback URL** `{WEB_URL}/api/auth/callback/github` and **Setup URL**
  `{WEB_URL}/api/github/setup` (see [github-app.md](github-app.md)).
- Set `WEB_URL` on the API and worker to the same Vercel URL (it's used for links in PRs and
  notifications, and for redirects after installing the app).

Until the required variables are set, every page shows **Setup needed** with the names of the
missing ones (never values) instead of a server error. `API_URL` is read at build time, so redeploy
after changing it.

## 4. Check it

1. Open `{WEB_URL}/login` and sign in with GitHub. You should land on your organizations.
2. Open a task page and watch it update without reloading: that's the event stream through the
   proxy.
3. Settings → AI keys: add a key; it is checked by the API.

## Known limits

- **Live updates through Vercel's proxy.** `/api/events` is a long-lived server-sent event stream.
  If Vercel's proxy closes it, the browser reconnects at once and the API replays what was missed
  (`lastEventId`), so updates arrive slightly late rather than being lost. Pages also poll slowly as
  a safety net.
- Preview deployments get their own URLs; GitHub only allows the callback URLs you register, so
  sign-in works on the production domain unless you register a preview domain too.
