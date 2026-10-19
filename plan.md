# AutoDev plan

Working agreement (from the project brief):

- Work phase by phase. Before each phase, show a short plan (files, schema changes, endpoints) and wait for approval. After each phase, summarize what was built and wait for the go-ahead.
- Section A is the core product. Section B adds features on top; the design must stay open for them.
- Tech stack is fixed unless the owner approves a change (see "Deviations" below).

Status key: **done**, **partial**, **not started**, **deviates** (built, but differs from the brief).

---

## Section A: core product

| Phase | Scope (from brief) | Status | Notes |
|---|---|---|---|
| A1 | Auth, orgs, repo access: GitHub App login with user tokens, roles owner/admin/developer/viewer, writable repo list (15 min cache, webhook refresh, live re-check before push/PR) | done | Live re-check before a push is in the push flow (A-6). |
| A2 | BYOK: Anthropic provider behind a provider interface, key scopes user → team → org, envelope encryption, write-only UI, daily re-validation, metering, budgets, blocked_on_key | done | Budgets: the 80% soft warning was not re-verified in this audit. Keys are decrypted in memory per call only. |
| A3 | Task board and list, keys like AD-142, task fields, branch_mode, related task, create_pr toggle | done | |
| A4 | Modes plan_lld / plan_only / direct, org default and repo lock, versioned Plan and LLD with Approve / Request changes / Reject, deviation pause, agent questions, scope_path | done | |
| A5 | Cloud agent runtime: LLM calls in a BullMQ worker, GitHub reads at base SHA, virtual workspace with overlay, tools, prompt caching | **deviates** | The overlay is stored in Postgres, not S3. `docs/schema.md` says blobs move to S3 later. |
| A6 | Local builder: `autodev-runner` CLI, device-code pairing, outbound WebSocket, heartbeat, offline queue, auto pickup, worktree, `.autodev.yml` only, consent for changes to it, Docker mode, one job at a time, fix-test loop (default 3 cycles), shared team builder (Docker only), protocol schemas | partial | Built: pairing, gateway, presence, offline queue, consent, team builder kind, `maxFixCycles` (default 3). Not checked: the 20 s / 60 s values and single-binary packaging for macOS, Linux and Windows. |
| A7 | Push and PR: `autodev/<KEY>-<slug>` branches, PR with Summary / Task / Approved Plan / Approved LLD / Changes / Testing / AI usage, Create PR button, updates on existing PRs, stale-branch job, webhooks, no AI review | done | |
| A8 | The 18 task statuses | done | All 18 present in `taskStatus`. |
| A9 | Realtime events: task.status, agent.step, agent.question, doc.ready, builder.presence, job.queued_offline, test.log, test.result, branch.pushed, pr.opened, pr.updated, usage.tick | **partial, deviates** | Only task-change notifications are built, over Server-Sent Events, not WebSocket. The other events aren't emitted. |

Section A database: the tables in the brief exist, with these differences: `task_documents` is versioned (done), `token_usage` is not partitioned by month in code (a partition job exists), `audit_log` is append-only (done).

### Section A deviations to decide on

1. **Overlay storage:** Postgres instead of S3 for workspace blobs. Keep, or add S3 now?
2. **Realtime transport:** SSE instead of WebSocket for web updates. The builder gateway does use WebSocket.
3. **Event coverage (A9):** only task changes. Add the missing events?
4. **Builder packaging:** the single-binary build for macOS, Linux and Windows isn't confirmed.

---

## Section A rework: decisions and plan (approval pending)

Decisions from the owner:

1. **Blob storage:** Postgres is the default, behind a `BlobStore` interface in a new `packages/storage`. All blob access (workspace snapshots, patches, builder logs) goes through it.
   - Postgres driver: table `blobs(hash pk, size, encoding, content bytea, created_at)`, gzip on write, content-addressed by sha256 so duplicates are stored once.
   - S3 driver (off by default): any S3-compatible endpoint (`S3_ENDPOINT`, `S3_BUCKET`, `S3_KEY`, `S3_SECRET`), tested against MinIO in docker-compose.
   - Selected by `BLOB_DRIVER=postgres|s3`.
   - `pnpm blobs:migrate --to s3|postgres` copies blobs, verifies hashes, and is safe to re-run.
   - Nightly cleanup with configurable retention: builder logs 30 days, snapshots of finished tasks 14 days, final patches kept forever.
2. **Realtime:** keep SSE for the web app. One stream per tab at `GET /events?topics=…`, served by Fastify over HTTP/2. Redis pub/sub fans events out. Event ids with replay on `Last-Event-ID` (Redis streams). Heartbeat every 15 s. WebSocket is used only by the builder gateway. Socket.IO is not present, so nothing to remove.
3. **Emit all Section A events.** Envelope `{id, type, topic, orgId, ts, payload}`, Zod schemas in `packages/protocol`, a typed `useEvents(topics)` hook, and an authorization check on every topic subscription.
   - Task topic: `task.status`, `task.updated`, `agent.step`, `agent.question`, `agent.question_answered`, `agent.deviation`, `doc.ready`, `doc.reviewed`, `job.created`, `job.queued_offline`, `job.started`, `job.consent_required`, … (**the pasted list was cut off after `job.consent_required`; the rest of the event list is still needed**)

### Status

- **R-1 Blob storage: done** (approved). Details in "R-1 notes" below.
- **R-2 Realtime transport: done** (approved). Details in "R-2 notes" below.
- **R-3 Full event catalogue: built, awaiting review.** Details in "R-3 notes" below.
- R-4 Builder: not started.

### R-1 notes

- `packages/storage`: `BlobStore` interface (content-addressed by sha256), Postgres driver (gzip), S3 driver (any S3-compatible endpoint), memory driver for tests, `BLOB_DRIVER` selection, `pnpm blobs:migrate --to s3|postgres`.
- Migrations 0017 (rebuilt `blobs` table, existing bytes kept and renamed to their hashes, references moved from keys to hashes, guard that stops the migration if a patch can't be mapped) and 0018 (restores the app-role revoke).
- Retention per org (Settings): logs 7–365 days (default 30), snapshots 1–90 days (default 14). Nightly sweep at 04:00 UTC. Patches are never cleared. Unreferenced blobs older than 24 h are deleted.
- Verification: storage tests 18/18 (Postgres, memory and S3 drivers); retention tests 4/4; `blobs:migrate` copied 41 blobs to a local S3 emulator and back, twice, with all verified; agent 51, API 85, DB 30, builder gateway 8, Playwright e2e 10/10.

**Deviations from the decision, to confirm:**

1. **MinIO not tested.** The MinIO image can't be pulled anonymously here. The S3 tests use `s3rver`, a local S3 emulator. Run `docker compose --profile s3 up -d` after `docker login` to test against MinIO.
2. **"Workspace snapshots" are agent transcripts.** The only snapshot-like data stored as blobs is the agent transcript. The workspace file overlay stays in `workspace_files`, which isn't blob storage.
3. **Blobs have no org column.** Identical content from two orgs is stored once. A blob is reachable only through a row that belongs to an org.
4. **The sweep loads every referenced hash into memory.** Fine at current size; it will need batching at large scale.

### R-2 notes

- `GET /events?org=<id>&topics=…` replaces `/events/tasks`. Topics: `repo:<id>`, `user:<id>`, `org`, `org:admin`, each authorized before the stream opens (membership, repo access row, same user, admin role).
- `packages/events`: publish (Redis stream per org, about 10,000 events, plus pub/sub), replay after `Last-Event-ID`, one subscriber connection per API process. The stream subscribes before replaying and holds live events until the replay is written, so there's no gap and no duplicate.
- Envelope `{id, type, topic, orgId, ts, payload}` and topic rules in `packages/protocol`. The `id` is the Redis stream id.
- Postgres task triggers now carry txid, table and row id (migration 0019). Every API process listens; each change is published once (Redis `SET NX`) as `task.updated` on the repo topic.
- Heartbeat 15 s. HTTP/2 when `TLS_CERT_FILE` and `TLS_KEY_FILE` are set (HTTP/1.1 still accepted).
- Web: `useEvents(orgId, topics, onEvents)` with 250 ms batching; the board and task page use it. Socket.IO was never present.
- Verification: API 91 (10 new event tests), protocol and events unit tests, DB 30, agent 51, gateway 8, storage 18, e2e 10/10. Checked by hand over HTTP/2 with TLS: a database change reached an authenticated stream with an `id:` line.

**Deviations to confirm:**

1. **The stream takes an `org` parameter** as well as `topics` (`/events?org=…&topics=…`). EventSource can't send headers, and a tab works in one org.
2. **HTTP/2 needs TLS.** Browsers don't speak HTTP/2 without TLS, so the API serves HTTP/2 only when given a certificate; otherwise a TLS proxy in front provides it.
3. **Replay window is about 10,000 events per org.** A tab offline longer than that misses events; the 60 s fallback poll covers it.
4. **Task changes are coarse until R-3.** Every task-table change is one `task.updated` event; R-3 adds the specific types.

### R-3 notes

- Catalogue in `packages/protocol/src/events.ts`: all 37 agreed event types with Zod payloads and the topic kinds each may use, plus the typed `AppEvent` union. A test checks it matches the agreed list group by group.
- New topic `task:<id>` (authorized through the task's repo). Task-group events go there; `task.created`, `task.moved`, `task.deleted` go to `repo:<id>`; user events to `user:<id>`; admin events to `org:admin`.
- Source of events:
  - From committed rows (migration 0020): one generic trigger, `notify_row_change`, on 14 tables, sends only the columns each table lists. `packages/events/src/changes.ts` maps a change to events (pure, unit tested). Replaces the task-only triggers from 0013/0019.
  - Explicit: `builder.presence` (gateway, on hello and on disconnect, including silence drops), `test.log` (gateway, at most one per second per job, 16,000 characters per event), `stale_branch.found` (nightly sweep).
- Each event has its own dedupe key, so one change heard by every API process is published once, and a budget alert sent to several admins reaches `org:admin` once.
- `emit()` checks the payload and the topic kind before publishing.
- Web: one stream per tab shared by every `useEvents` caller, reopened when the topic set changes (with `lastEventId`, so nothing is lost). Board on `repo:`, task page on `task:` (test logs refresh only the log), notifications bell and builders page on `user:`.
- Fixed along the way: the gateway handled a builder's messages concurrently, so a result could overtake the log lines sent before it. Messages are now handled in order, per builder.
- Verification: events 12 (catalogue, every table's mapping, emit validation), API 95 (task, notification, budget-once, member events end to end), gateway 11 (presence, batched logs), worker 6, DB 30, agent 51, storage 18, protocol 7.

**Deviations to confirm:**

1. **`task.status` and `task.moved` are both sent for every status change.** The board only needs `task.moved`; the task page needs `task.status`.
2. **`task.updated` means "a task field changed, but not its status or pushed commit".** Status and pushes have their own events.
3. **`task.deleted` never fires today.** Tasks aren't deleted anywhere in the product; the mapping is there for when they are.
4. **Builder presence goes to the owner's topic only.** Other members watching a team builder get its status from the builders page's 30 s poll.
5. **Admin pages don't use `org:admin` yet.** The events are emitted and tested; the settings and AI-keys pages still poll.

### Proposed phases (each needs approval before coding)

**R-1 Blob storage**
- New `packages/storage`: `BlobStore` interface; `PostgresBlobStore` and `S3BlobStore`; selection by `BLOB_DRIVER`.
- Schema migration: replace `blobs(key, content, content_type, size)` with `blobs(hash, size, encoding, content, created_at)`. Existing rows are migrated by hashing their content.
- Move every caller off the current `PgBlobStore` in `packages/agent/src/blob-store.ts`: orchestrator, builder jobs, repo reader, repo chat, API agent router, worker, builder gateway.
- `pnpm blobs:migrate` script with hash verification.
- Nightly cleanup job with retention settings (new org or env config).
- Tests: both drivers against one shared suite; MinIO in docker-compose for the S3 driver test.

**R-2 Realtime transport**
- Replace the task-only SSE route (`/events/tasks`) with `/events?topics=…`.
- Replace the Postgres `NOTIFY` bridge: a listener publishes to Redis pub/sub and appends to a Redis stream per org (for replay, with trimming).
- Authorization per topic at subscribe time. Replay on `Last-Event-ID`. 15 s heartbeat.
- `useEvents(topics)` hook; migrate the board, task page and agent panels off their polling where events now cover it.

**R-3 Full event catalogue**
- Zod envelope and payload schemas in `packages/protocol`.
- Emit each event from the code path that causes it (orchestrator, builder gateway, API routers, webhooks).
- Tests: each event type is emitted once per change, and a subscriber in another org receives nothing.

Open questions for the owner:

- Send the rest of the event list (the paste stopped after `job.consent_required`).
- Retention defaults for the nightly job: are 30 / 14 days and "forever" for patches right, and should they be configurable per org?
- Should R-1 run before R-2, or in parallel? R-2's replay depends on the envelope, not on storage, so they can be done separately.

---

## Section B: after Section A

The brief's phase names are B-1 to B-7. The brief also has feature headings B1 to B8. The phases are the reference below.

| Phase | Scope (from brief) | Status | Notes |
|---|---|---|---|
| B-1 Prompt guide | Templates (bug fix, feature, refactor, add tests, UI change), org-owned templates, live checker that scores 0–100 and flags missing repro, acceptance criteria, file hints, vague scope, one-click rewrite; score stored on the task; policy `prompt_check` | **partial, not to spec** | Built a one-shot "Review prompt" button with issues and a rewrite. No templates, no 0–100 score, nothing stored on the task, and the use case is named `prompt_guide`, not `prompt_check`. Built before a plan was approved. |
| B-2 Repo chat | Private chat per user per repo, shared team channel per repo, RAG with tree-sitter chunks and pgvector, incremental re-index on push, file and line citations linked to GitHub, one-click "make this a task", `store_code_index` setting, tables chat_sessions, chat_messages, repo_channels, channel_messages, code_chunks; Repo Agent memory (B-2 includes it) | **partial, not to spec** | Built: private chat per user, answers from live reads (read_file, list_dir, search_code), file citations, RLS. Not built: team channel, RAG and indexing, `store_code_index`, one-click to task, repo agent memory, GitHub links on citations. Built before a plan was approved. |
| B-3 Cross-repo sync | Repo links (source → target, mapping notes, optional two-way), "Apply to linked repo" creates a target task with source diff and PR context, cross-linked PR descriptions, `repo_links`, `tasks.source_task_id` | not started | |
| B-4 Insights and leaderboard | Nightly rollups (`user_metrics_daily`), admin dashboard, leaderboard snapshots, Impact score, visibility controls, cost hiding, badges | not started | |
| B-5 Group Agent | Scheduled org-wide scans, weekly digest with health score, recommendations to tasks, Draft PR default and safety levels, own budget and weekly PR cap; tables recommendations, group_agent_findings, agent_policies | not started | |
| B-6 Billing and onboarding | Per-seat Stripe subscriptions, Team/Business/Enterprise, onboarding flow, `subscriptions` table, `/billing/checkout`, `/webhooks/stripe` | not started | |
| B-7 Enterprise pack | SSO (WorkOS), SCIM, extra roles, retention, SIEM export, IP allowlist, data region, more LLM providers, self-hosted Helm chart, Jira sync (`jira_issue_key`) | not started | |

### What exists in code but is not in the phase list

- `packages/llm` already has the provider interface for OpenAI, Azure OpenAI and Bedrock. Only Anthropic is implemented.
- `chat` and `prompt_guide` LLM use cases exist in the enum. Using `chat` for repo chat is consistent with B-2, but `prompt_guide` should be renamed to `prompt_check` if B-1 follows the brief.

---

## Next step

**B-1 Prompt guide, to be approved before coding.** Proposed plan:

- **Schema:** add `tasks.prompt_score` (int 0–100), `tasks.prompt_score_details` (jsonb: flags and suggestions), `tasks.prompt_checked_at`. New table `prompt_templates` (org_id nullable for built-ins, name, kind, body_md, created_by). Rename the enum value `prompt_guide` → `prompt_check` with `ALTER TYPE ... RENAME VALUE`, so no data is lost.
- **Built-in templates:** bug fix, feature, refactor, add tests, UI change, in code. Org admins can add and edit their own in `prompt_templates`.
- **Endpoints:** `promptGuide.check` returns score, flags, and rewrite (replacing `review`). `promptGuide.templates.list`, `create`, `update`, `delete` (admin only). `tasks.create` and `tasks.update` store the score.
- **Web:** template picker on the task form, a live checker (debounced, about 1 s after the user stops typing), a score badge, and a one-click rewrite.
- **Tests:** scoring and flags with a scripted model, template permissions, the score being stored on the task, and an RLS check on `prompt_templates`.

Decision needed: keep the built-in review button as an extra, or replace it with the live checker?
