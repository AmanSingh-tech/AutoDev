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
- **R-3 Full event catalogue: done** (approved). Details in "R-3 notes" below.
- **R-4 Builder: built, awaiting review.** Details in "R-4 notes" below.

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

### R-4 notes

- **Timing tests:** the runner sends no heartbeat before 20 s and one every 20 s after (fake intervals, real socket); the gateway, with its real defaults, keeps a builder that heartbeats every 20 s, drops one silent for more than 60 s at the next 10 s sweep, and its presence key expires after 60 s.
- **Single binaries:** `apps/runner-cli/scripts/build-sea.mjs` (rewritten; the old one never ran) bundles with esbuild into one CommonJS file and injects it into Node with SEA, named `autodev-runner-<os>-<arch>`. It smoke-tests `--version`. Release builds take their version from the tag.
- **npm package:** `scripts/pack-npm.mjs` prepares `autodev-runner` (bins `autodev` and `autodev-runner`, Node 18.18+).
- **Release workflow:** `.github/workflows/release-runner.yml`. Tag `runner-v*` builds the five targets on native runners, runs each binary, creates the GitHub release with SHA256SUMS, and publishes to npm. Signing, notarization and npm publishing are skipped with a notice when their secrets are missing. Dry run via "Run workflow".
- **Windows:** every git command the runner runs gets `core.longpaths=true` on Windows. `apps/runner-cli/README.md` documents Docker Desktop with WSL 2 for Docker mode and the Windows long-path setting.
- Verification: runner 19 tests (3 new), gateway 12 (1 new); the Linux x64 binary built and ran with no Node on PATH; the npm package packed, installed from the tarball and ran on Node 22 and Node 18; actionlint 1.7.7 (with shellcheck) passes.

**Not verified, to confirm:**

1. **Only the Linux x64 binary was built here.** macOS, Linux arm64 and Windows are built by the workflow, which hasn't run yet. A dry run ("Run workflow") would check all five without publishing.
2. **Signing is untested.** The steps follow Apple's and Microsoft's standard commands but need real certificates to prove.
3. **The npm package is marked `UNLICENSED`.** Set the license you want before the first publish, and make sure the name `autodev-runner` is free on npm.
4. **macOS binaries can't be stapled.** A bare binary is notarized online; offline Macs check it on first run.

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
| B-1 Prompt guide | Templates (bug fix, feature, refactor, add tests, UI change), org-owned templates, live checker that scores 0–100 and flags missing repro, acceptance criteria, file hints, vague scope, one-click rewrite; score stored on the task; policy `prompt_check` | **done** | See "B-1 notes" below. |
| B-2 Repo chat | Private chat per user per repo, shared team channel per repo, RAG with tree-sitter chunks and pgvector, incremental re-index on push, file and line citations linked to GitHub, one-click "make this a task", `store_code_index` setting, tables chat_sessions, chat_messages, repo_channels, channel_messages, code_chunks; Repo Agent memory (B-2 includes it) | **done** (part 2 awaiting review) | See "B-2 notes" below. |
| B-3 Cross-repo sync | Repo links (source → target, mapping notes, optional two-way), "Apply to linked repo" creates a target task with source diff and PR context, cross-linked PR descriptions, `repo_links`, `tasks.source_task_id` | **built, awaiting review** | See "B-3 notes" below. |
| B-4 Insights and leaderboard | Nightly rollups (`user_metrics_daily`), admin dashboard, leaderboard snapshots, Impact score, visibility controls, cost hiding, badges | not started | |
| B-5 Group Agent | Scheduled org-wide scans, weekly digest with health score, recommendations to tasks, Draft PR default and safety levels, own budget and weekly PR cap; tables recommendations, group_agent_findings, agent_policies | not started | |
| B-6 Billing and onboarding | Per-seat Stripe subscriptions, Team/Business/Enterprise, onboarding flow, `subscriptions` table, `/billing/checkout`, `/webhooks/stripe` | not started | |
| B-7 Enterprise pack | SSO (WorkOS), SCIM, extra roles, retention, SIEM export, IP allowlist, data region, more LLM providers, self-hosted Helm chart, Jira sync (`jira_issue_key`) | not started | |

### What exists in code but is not in the phase list

- `packages/llm` already has the provider interface for OpenAI, Azure OpenAI and Bedrock. Only Anthropic is implemented.
- The `chat` LLM use case exists for repo chat, consistent with B-2. `prompt_guide` was renamed to `prompt_check` in B-1.

---

### B-1 notes

Approved decisions: the live score is rule-based (no AI cost per keystroke); the model runs only on **Check deeper** and **Rewrite**; the old **Review prompt** button is replaced.

- **Schema (0021):** `prompt_templates` (RLS `tenant_isolation`, kind checked against the five kinds, unique name per org); `tasks.prompt_score`, `prompt_score_details` (`{version, flags}`), `prompt_checked_at`; enum value `prompt_guide` renamed to `prompt_check` with `RENAME VALUE`.
- **Rules and built-ins:** `packages/protocol/src/prompt-check.ts`, shared by the form and the API so the shown score is the saved one. Penalties: acceptance criteria 30, repro 25, vague scope 20, file hints 15, unfilled `[TODO]` 10.
- **API:** `promptGuide.check`, `promptGuide.rewrite` (push access, org key and budgets), `promptGuide.templates.list/create/update/delete` (changes admin only, audited). `tasks.create` and `tasks.update` store the score.
- **Web:** template picker on the task form, live score with flags, Check deeper, Rewrite with Undo, score on the task page, Settings → Task templates (add, edit, delete, copy a built-in).
- **Tests:** rule tests (protocol), model check and rewrite with a scripted model (agent), endpoints, permissions, cross-org isolation and metering under `prompt_check` (API), score stored on create and edit (API), RLS (db), and an end-to-end test of the whole flow.

**Deviations from the brief:**
- "Templates for org" with `org_id` nullable for built-ins (as first proposed) became built-ins in code plus an org-only table, so built-ins can change with releases without a migration.
- Admin-only template changes are enforced in the API, not in RLS (RLS has no role function), the same as other admin settings.
- Bug detection is a heuristic (bug words in the title, or strong ones like "crash" in the description). It can miss or over-flag, and the flag is advice only: it never blocks saving or starting.

### B-2 notes

Approved decisions (2026-10-20): embeddings from an open code model run in the worker (`jina-embeddings-v2-base-code` via transformers.js), behind a provider interface so Voyage can be added later; chat tables renamed to the brief's names; memory edited by people with push access plus admins; stop for a go-ahead between part 1 and part 2.

**Part 1 (done): chat, team room, Repo Agent memory**
- **Schema:** 0022 renames `repo_chats` → `chat_sessions`, `repo_chat_messages` → `chat_messages` (`chat_id` → `session_id`, `sources` → `citations` with old paths converted). 0023 adds `repo_channels`, `channel_messages`, `repo_agent_memory`, `chat_messages.commit_sha`, RLS `repo_readers` (org + repo access) and realtime triggers.
- **Agent:** `repo-qa.ts` (shared scope, tools incl. `git_log`, memory in the system prompt, citation parsing), `repo-chat.ts` (private), `repo-agent.ts` (`@agent` in the room, room transcript as context, runs as the person who mentioned it).
- **API:** `chat.*` on the renamed tables, `room.get/post`, `repoAgent.memory.get/update` (audited). `repos.byName` returns `htmlUrl` for links.
- **Web:** repo tabs; private chat with citations and live updates; team room; memory page; "Make this a task" pre-fills the new-task form.
- **Events:** `chat.message` (user topic), `channel.message`, `repo_agent.memory_updated` (repo topic).
- **Tests:** RLS for all chat tables, runner and agent with a scripted model, citation parsing, API permissions and queueing, events mapping, and an end-to-end test (room → @agent → cited answer → task → memory edit).

**Deviations and limits:**
- Admins edit memory without push access, but still need some access to the repo on GitHub (RLS), the same as reading it.
- The room shows the latest 100 messages; older history is kept but not paged yet.
- Citations come from `path:start-end` references in the answer, kept only when the file exists at the answer commit; line numbers aren't checked against the file length.
- Found while testing: two end-to-end specs could leave an AI key behind when cleanup ran before the key list loaded. Both now wait for the list first.

**Part 2 (built, awaiting review): code index**

Approved decisions (2026-10-21): `storeCodeIndex` is **off by default**; tree-sitter for TS/JS, Python, Go, Java, Rust, Ruby, C# (other files in line windows); at most 20,000 files per repo.

- **Package `packages/code-index`:** file filter (vendored/build folders, lockfiles, binaries, minified, > 200 KB), tree-sitter chunker (`web-tree-sitter` 0.22 + `tree-sitter-wasms`; definitions get their own chunk, named like `Store.get`; neighbours merged up to 80 lines / 4,000 characters; big ones split into windows; every line covered), `Embedder` interface with `LocalEmbedder` (`jina-embeddings-v2-base-code`, 8-bit, transformers.js, in-process) and `FakeEmbedder` (tests and e2e), `CodeIndexer`, hybrid search.
- **Schema (0024):** `code_chunks` (vector(768) with HNSW cosine, tsvector with GIN), `code_index_state` (one row per repo), enum `code_index_status`. RLS `repo_readers`; the app role can only read; realtime trigger on the state table.
- **Indexing:** reads with the **installation token**. Incremental by blob sha: only new or changed files are read and embedded, gone files lose their chunks; a file's chunks are written in one INSERT, so it is never half indexed. A push during a run triggers up to two more runs. A different model in the state row means a full re-index. Checks the setting during and after a run, and deletes what it wrote if it was turned off.
- **Queue `code-index`:** jobs `repo` (one job id per repo), `org` (fans out), `nightly` (05:00 UTC, every org with the index on), `purge`. Triggered by turning the setting on, by repo sync (new repos), by a push to the default branch (30 s delay, so a burst shares a run), by admins (Rebuild), and nightly.
- **Search:** pgvector nearest neighbours (with `hnsw.iterative_scan`, since the index is shared by all repos) and full-text over words with identifiers split (`totalInvoice` → total, invoice), merged by reciprocal rank fusion. Chat's `search_code` returns `path:start-end (symbol)` with an 8-line snippet, drops files gone at the answer commit, says when the index is behind, and falls back to GitHub code search when there's no index, no hits or an error.
- **API:** `orgs.updateSettings({ storeCodeIndex })` (admin, audited; queues a build or a purge), `codeIndex.status`, `codeIndex.reindex` (admin, audited), `push` webhook.
- **Web:** status line under "Ask the repo" (live via `code_index.status`, Rebuild for admins); Settings → Code index card, saved on its own with a confirm before deleting.
- **Event:** `code_index.status` on `repo:<id>` (38th event in the catalogue).
- **GitHub App:** `push` added to the manifest and `docs/github-app.md`.
- **Tests:** code-index 21 (chunking per language, filters, incremental runs, push mid-run, cap, model change, failure, purge, search, RLS), agent +3 (indexed search, behind-commit note, fallbacks), API +4 (setting, status, reindex, push webhook), worker +4, events +1, and e2e `code-index.spec.ts` (turn on → worker indexes through the mock's installation token → chat finds code with the index → turn off → back to GitHub search). Full run: 33 typecheck and test tasks green.

**Deviations and limits, to confirm:**
1. **The index can lag the answer commit.** It follows the default branch through pushes and the nightly run; chat reads files at the live head, drops hits for deleted files and tells the model when line numbers may have moved.
2. **Old installations need to accept the Push event** on GitHub. Until then, repos are re-indexed nightly only.
3. **Binary or empty files with no chunks are read again on every run.** The extension filter makes them rare; recording them would need another table.
4. **The setting lives in `orgs.settings` JSON** (as the schema comment intended), not a column; the API presents it as `storeCodeIndex`.
5. **e2e now uses a generated App key** and the mock issues installation tokens, so background jobs that use the installation token can be tested end to end.
6. **The first index of a repo is slow on CPU.** Measured on this repo (418 files → 4,285 chunks, 1,030 characters on average) on a 12-thread laptop CPU: chunking takes 2 s, embedding runs at about 3 chunks a second, so the first index takes about 25 minutes. Later pushes only re-embed changed files (seconds). The worker peaks at about 1 GB. The first test, with 4,000-character chunks in batches of 16, ran out of memory, so chunks are now at most 1,500 characters and batches 8, sorted by length. A hosted embedder (Voyage) behind the same interface would make first runs fast, at the cost of sending code to that service.
7. **The model download (about 160 MB) happens on the worker's first index**, not at deploy. Set `EMBEDDINGS_CACHE_DIR` to a persistent volume so restarts don't download it again.

### B-3 notes

Approved decisions (2026-10-20): the original PR is edited with the **port owner's** GitHub account; Apply creates a **draft** task directly; only **admins** manage links.

- **Schema (0025):** `repo_links` (source, target, `two_way`, `mapping_notes_md` ≤ 8,000, one link per pair in either direction, no self-links); `tasks.source_task_id` and `tasks.source_context_md` (≤ 60,000, frozen at creation). RLS `repo_readers`: read if you can access either repo, write only with access to both; admin-only changes are enforced in the API and audited.
- **The change:** from GitHub's compare of the task's base and pushed commits (so commits people added to the branch count), otherwise the agent's own workspace patch. Frozen into `source_context_md` with the source task, its PR and the mapping notes.
- **API:** `repoLinks.list/create/update/delete`; `tasks.applyToLinked({ key, targetRepoId })` checks the link direction, the caller's live push access to the target and that the source has a change, then creates a draft "Port AD-12: …" with the description and acceptance criteria copied, recorded on both timelines. `tasks.get` returns `source` and `ports`.
- **Agent:** the task message gets a "Port this change" section (notes and diff wrapped as data) and an instruction to adapt the change rather than copy it.
- **PRs:** the port's PR body has a Source section; when the port's PR opens, a "Ported to" line is added to the original PR as the port's owner. If they can't edit that repo it's skipped and recorded on the task (`source_pr.not_updated`); publishing never fails because of it.
- **Web:** Settings → Linked repositories (admins add, edit, remove); task page: "Apply to <repo>" buttons, "Ported from" / "Ported to", and the frozen change in a collapsible section.
- **Tests:** RLS (`rls-repo-links.test.ts`), API 7 (permissions, direction, both diff sources, size cap, org isolation), agent (context, prompt section, PR body), publisher (source PR edit and the skip), e2e `cross-repo.spec.ts`.

**Deviations and limits, to confirm:**
1. **Only pushed work can be applied** (pushed, PR open or resolved). The plan said "when the task has changes"; unpushed drafts can't be ported yet. The workspace-patch fallback covers pushed tasks whose compare is empty.
2. **The frozen change can go stale** if the source branch moves after the port is created; apply again for a fresh copy.
3. **Very large diffs are cut** to fit the 60,000-character context; the cut is marked so the agent knows.
4. Finished in this session after the earlier one hit its usage limit: the e2e spec needed an exact label match and to cancel the port it creates, so reruns against the dev DB start clean. `byok` and `prompt-guide` waits now allow for Next dev compiling a page on first visit.

### Frontend polish and Vercel (2026-10-20)

Approved: polish and motion, toasts, phone feel and a robustness pass, using Emil Kowalski's skills (read, not installed); Vercel for the web app only; option (a), sign-in stays in the web app.

- **Motion:** easing tokens and `enter`/`fade`/`pulse-dot` animations in the UI preset; button press feedback; arrivals-only entrance for chat and room messages (`useArrivals`); `<Pending>` for waits; reduced motion respected.
- **Toasts:** Sonner, mounted once; success toasts for silent actions; the prompt guide's Undo moved into the rewrite toast.
- **Phones:** viewport export (cover, theme colors, keyboard resize), tap highlight off, 16 px inputs on touch, hover only where supported, `dvh`, safe-area padding, sideways-scrolling tab rows, a one-line header.
- **Robustness:** `pnpm db:seed:worst` (own mock GitHub user, so demo and e2e are unaffected). Fixed: unbreakable titles, paths and URLs overflowing the page (task page, room, memory page), grid columns widened by tables (usage), board card key/priority collisions and very tall cards, citation walls, table columns squeezed to two words.
- **Vercel:** `apps/web/vercel.json`; build needs no secrets; the web app now requires only the GitHub settings sign-in uses (no App private key or webhook secret) and only the system database URL. Guide: `docs/deploy-vercel.md`.
- **Tests:** e2e now uses the toast's Undo, and `mobile.spec.ts` checks no sideways scroll at 375 px and 16 px inputs.

**Decisions left open:**
- The board loads the latest 200 tasks of a repo and its column counts are of those, so a repo with 1,000 tasks shows partial counts. Options: real counts from the server plus "load more" per column, or keep it and label the board "latest 200".
- On phones the members table and task list scroll sideways inside their box rather than becoming stacked cards.
- Not checked on a real phone: sticky hover, tap delay, safe areas and input zoom need hardware.

## Next step

**Review B-2 part 2 (code index) and B-3 (cross-repo sync), then commit.** Next phase: B-4 (insights and leaderboard), plan first.
