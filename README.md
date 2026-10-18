# AutoDev

Multi-tenant B2B SaaS: developers hand coding tasks to an AI agent that plans, designs, codes,
tests on the developer's own machine, and opens a GitHub PR **as the developer**.

**Status:** Section A, phases A-1 (monorepo, schema, GitHub App sign-in, orgs and roles,
write-access repo list), A-2 (bring-your-own LLM key, model policies, metering, budgets), A-3
(task board) and A-4 (agent runtime, virtual workspace, Plan and LLD gates).

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
packages/llm          Provider interface, Anthropic provider, LLM gateway (keys, metering, budgets)
packages/agent        Virtual workspace, tools, prompts, agent loop, orchestrator
packages/protocol     later phases
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

docker compose up -d          # (or docker-compose) Postgres 16 + pgvector on :5433, Redis on :6379
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

## BYOK and metering (A-2)

- **Keys:** org, team or personal. The most specific key wins (personal, then team, then org;
  for someone in several teams with keys, their primary team). Keys are encrypted with the org's
  data key, checked with a free `models.list` call before saving, re-checked daily, and
  write-only (only the last 4 characters are shown). The app DB role can't even SELECT the
  ciphertext; only the gateway (system role) decrypts, in memory, for one call. Rotation
  supersedes the old key in one transaction, and calls already running finish on the old key.
- **Gateway** (`packages/llm`): the only way code reaches an LLM. It applies the model policy
  (default `claude-opus-5-5`, effort `high`), the per-task token cap (it also clamps
  `max_tokens`), and server-side refusal fallback. It meters every call from the provider's
  usage fields (one row per model, cost frozen at write time). An auth, permission or billing
  failure marks the key invalid, notifies admins, and raises `KeyFailure` (A-4: `blocked_on_key`).
- **Budgets:** monthly (UTC) org and per-user limits. Admins are notified once at the soft
  threshold and once at the limit. A hard limit blocks new runs (`assertRunAllowed`), while
  runs already going continue within their task cap.
- **Prices:** global Anthropic rates seeded by migration; admins add per-org overrides
  (effective-dated). Models without a price are metered as `priced = false`, not guessed.

## Task board (A-3)

- **Keys** like `AD-142` are numbered per org (gap-free, minted under a row lock). The prefix is
  set in Settings, and existing tasks keep their key if it changes.
- **Creating a task** requires push access to the repo and a non-viewer role. The workflow is the
  repo's locked mode if set, else the chosen one, else the repo default, else the org default.
  Existing-branch tasks are checked against GitHub with the user's token, and the agent starts
  from that branch's head. New branches are named `autodev/<KEY>-<slug>`. `scope_path` must be a
  folder inside the repo. A related task (same org) feeds its summary to the agent for follow-ups.
- **Statuses** follow one state machine (`packages/db/src/task-machine.ts`). Every change is a
  compare-and-set plus an append-only `task_events` row. Starting a task is refused up front when
  the owner has no working LLM key or hit a hard budget; otherwise an `agent` job is queued (A-4
  consumes it). Edits are allowed only in draft.
- **Board:** six columns (Draft, Queued, In progress, Needs you, Pushed / PR, Done). Only drafts
  can be dragged, onto Queued. The board polls every 15 s until realtime events land (A-9).

## Agent runtime (A-4)

- **Worker** (`agent` queue, `AgentOrchestrator`): driven by task status, idempotent, and one worker
  per task (Redis lock). `queued` pins the base SHA (head of the existing branch, or of the default
  branch) and opens a workspace; then the phase for the status runs: planning → `submit_plan`,
  designing → `submit_design`, coding → edits + `finish`.
- **Virtual workspace:** the base SHA read through the GitHub API with the owner's token (trees
  and blobs cached by content address), plus an overlay of edits in Postgres. There's no clone in
  the cloud. `patch()` yields a `git apply`-able diff for the builder. `scope_path` limits reads,
  edits, listing and search; `.github/workflows` and `.git` can't be touched.
- **Gates:** plan and LLD are versioned, immutable markdown with required sections. Approve /
  Request changes (the same conversation continues and writes v2) / Reject, audited. Coding may
  only edit files the approved docs name; anything else needs an approved `ask_user` deviation.
- **Pauses:** `ask_user` → `needs_input`; key failure → `blocked_on_key` (resumes automatically
  when a usable key is added); provider outages retry with backoff. Each pause resumes the same
  saved transcript (stored in the blob store), keeping thinking blocks verbatim.
- **Prompting:** the rules, then the repo conventions (README / CONTRIBUTING / .autodev.yml as
  `<repo_file>` data), both cached for 1h, then the task, the related task's summary and the
  approved docs. Repo content is always treated as data.
- **Builder hand-off:** `finish` / `request_local_test` move the task to `waiting_for_builder` with
  the workspace revision. A-5 runs the tests and feeds the results back into the paused run.

See [docs/schema.md](docs/schema.md) and [docs/github-app.md](docs/github-app.md).
