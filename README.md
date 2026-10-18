# AutoDev

Multi-tenant B2B SaaS: developers hand coding tasks to an AI agent that plans, designs, codes,
tests on the developer's own machine, and opens a GitHub PR **as the developer**.

**Status:** Section A is complete: A-1 (monorepo, schema, GitHub App sign-in, orgs and roles,
write-access repo list), A-2 (bring-your-own LLM key, model policies, metering, budgets), A-3
(task board), A-4 (agent runtime, virtual workspace, Plan and LLD gates), A-5 (local builder) and
A-6 (push, PR, stale branches, PR webhooks). Section B is not started.

## Layout

```
apps/web              Next.js 15 (App Router, Tailwind, shadcn/ui, TanStack Query, tRPC client)
apps/api              Fastify: tRPC for the web app, REST for webhooks / GitHub setup (and the builder later)
apps/worker           BullMQ workers (repo-sync now; agent, stale-branch, key-validation later)
apps/builder-gateway  WebSocket gateway for local builders (presence, offers, logs)
apps/runner-cli       autodev-runner CLI: runs test jobs on a developer's machine
packages/config       Zod env schemas, queue contracts
packages/crypto       AES-256-GCM envelope encryption, KMS-wrapped data keys
packages/db           Drizzle schema, migrations, RLS, withOrg(), seed
packages/github       Octokit clients, token vault, repo access cache, webhooks, login
packages/ui           shadcn-style components + Tailwind preset
packages/llm          Provider interface, Anthropic provider, LLM gateway (keys, metering, budgets)
packages/agent        Virtual workspace, tools, prompts, agent loop, orchestrator
packages/protocol     Builder ⇄ gateway messages and the .autodev.yml schema (Zod)
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
pnpm dev                      # web :3000, api :4000, worker, builder gateway :4100
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

## Local builder (A-5)

Tests run on the developer's own machine, never in the cloud:

```bash
pnpm --filter @autodev/runner-cli build
node apps/runner-cli/dist/cli.js login --api http://localhost:4000   # approve the code in the dashboard
node apps/runner-cli/dist/cli.js bind ~/src/my-repo                  # optional: reuse an existing clone
node apps/runner-cli/dist/cli.js start                               # Docker by default; --no-docker to opt out
```

- **Pairing:** OAuth device flow. The CLI receives a token exactly once, and only its sha256 is
  stored. Builders connect *out* over WebSocket (no inbound ports), send a heartbeat every 20 s,
  and count as offline after 60 s of silence. Revoking a builder disconnects it at its next heartbeat.
- **Jobs run automatically.** When the agent calls `finish` (or `request_local_test`), the patch
  and the **base branch's** `.autodev.yml` are snapshotted into a job and offered to the owner's
  online builder (bound clone first), or to a shared team builder (Docker only). Offline builders
  get a "Waiting for your builder" notice, and queued jobs go out as soon as a builder connects.
  One job runs per builder at a time.
- **Safety:** the first run per repo needs the builder owner's approval of the exact commands. A
  patch that edits `.autodev.yml` needs the task owner's consent, and the patched config is never
  run. Each job uses a temporary `git worktree` (the developer's checkout isn't touched), checks
  the patch sha256, runs only `setup` / `build` / `test`, and deletes the worktree afterwards.
- **Docker mode** (default): a fresh container per command, the worktree at `/workspace`, the host
  user ID, 2 CPUs / 4 GB, no capabilities, **no network except during setup**, and
  `timeout_min` ≤ 30. Shell mode passes a minimal environment (none of the developer's secrets).
- **Test-fix loop:** a failure after `finish` resumes the same coding conversation with the
  failing tests and a log tail (as data), up to the org's max fix cycles (default 3). A pass ends
  the run; pushing is A-6. Logs stream live to the task page.
- **Single binary:** `pnpm --filter @autodev/runner-cli build:binary` (Node SEA) needs **Node 20+**.
  Run it on macOS, Linux and Windows (e.g. a CI matrix). On Node 18, use `dist/cli.js`.

`.autodev.yml` (read from the base branch only):

```yaml
setup: pnpm install --frozen-lockfile   # the only step with network
build: pnpm build                       # optional
test:
  - pnpm lint
  - pnpm test
timeout_min: 15                         # max 30
docker_image: node:22-bookworm          # default
notes: Anything the agent should know (never executed).
```

Without a `.autodev.yml` on the base branch, tests are skipped and the task says so.

## Push and PR (A-6)

- **Push** happens after the final test run passes (or is skipped for lack of `.autodev.yml`). It
  uses the owner's own token after a **live** permission check, through the Git Data API (no clone).
  The branch is `autodev/<KEY>-<slug>`, or the existing branch for follow-up work; the default
  branch is never a target. File modes are kept, and the push never forces. If the branch moved
  upstream, the commit goes on top unless the same files changed, in which case the task fails
  with a clear reason and **Retry push**.
- **PR** (PRs live only on GitHub): opened against the default branch when
  `create_pr_on_completion` is on, otherwise via **Create PR** (as the clicking user). New commits
  to a branch with an open PR update it and append an "AutoDev update" section. The description has
  Summary, Task (link + acceptance criteria), Approved Plan, Approved LLD, Changes (one line per file),
  Testing (builder, image, commands, result) and AI usage (models, tokens, cost, approvers).
- **Stale branches** (nightly, 02:00 UTC): pushed without a PR for more than `stale_branch_days`
  (default 3) → open the PR as the owner (`created_by = stale_job`) or notify the owner once, per
  the org's `stale_branch_action`.
- **Webhooks** (`pull_request`): a merge marks the task **Resolved**; close/reopen/synchronize
  keep the mirror in sync; a PR opened by hand on a pushed task's branch is linked to it.
- Pushes, PRs and merges are in the audit log. There's no AI code review in this version.

See [docs/schema.md](docs/schema.md) and [docs/github-app.md](docs/github-app.md).
