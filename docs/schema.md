# Section A database schema

Every table has `id uuid` (UUIDv7, generated in the app) unless a composite PK is shown, plus
`created_at`/`updated_at`. **Tenant tables have `org_id` and row-level security**: request paths
connect as `autodev_app` and set `app.org_id` / `app.user_id` per transaction (`withOrg`). An
unset context returns no rows.

✅ = created in phase A-1. The rest are added by the phase that needs them.

## Identity (global)

| Table | | Notes |
|---|---|---|
| ✅ users | github_user_id UQ, github_login, name, email, avatar_url, last_login_at | RLS: yourself + members of the current org |
| ✅ github_tokens | user_id UQ, access_token_enc, refresh_token_enc, data_key_wrapped, kms_key_id, access/refresh_expires_at, revoked_at | Not accessible to the app role at all |

## Orgs and access

| Table | | Notes |
|---|---|---|
| ✅ orgs | github_account_id UQ, github_login, account_type, name, slug, data_key_wrapped, kms_key_id, data_key_version, default_task_mode, stale_branch_days, stale_branch_action, default_member_role, max_fix_cycles, task_key_prefix, task_seq, settings | Created only by the system role |
| ✅ org_members | PK(org_id,user_id), role, status | Users can read their own memberships across orgs |
| ✅ teams / team_members | | `github_team_id` reserved for sync |
| ✅ installations | github_installation_id UQ, account_login, permissions, events, installed_by, suspended_at, deleted_at | |
| ✅ repos | github_repo_id UQ, owner, name, full_name, default_branch, private, archived, deleted_at | |
| ✅ user_repo_access | PK(user_id,repo_id), permission, fetched_at, expires_at | 15-min cache; never used for push decisions |
| ✅ repo_policies | PK repo_id, locked_mode, default_mode, settings | |

## BYOK and metering (A-2)

| Table | | Notes |
|---|---|---|
| ✅ llm_credentials | scope org/team/user, provider, label, secret_enc, last4, config, status (active/invalid/superseded/revoked), last_validated_at, last_error, rotated_from_id | One active per slot; app role can't SELECT secret_enc |
| ✅ model_policies | UQ(org_id,use_case), provider, model, max_tokens_per_task, max_output_tokens, effort | |
| ✅ model_prices | org_id NULL = global; input/output/cache_write_5m/cache_write_1h/cache_read per MTok; effective_from/to | Global rows read-only to orgs |
| ✅ budgets | scope org/user, limit_usd, soft_pct, hard_block, last_soft/hard_alert_month | |
| ✅ token_usage | **monthly partitions** + default; tokens by class, cost_usd frozen, priced flag | Written by the system role only; partitions not directly readable |

Also added: `orgs.allow_user_keys`, `org_members.primary_team_id`.

## Tasks and agent (A-3, A-4)

| Table | | Notes |
|---|---|---|
| ✅ tasks | UQ(org_id,number), UQ(org_id,key), title, description_md, acceptance_criteria_md, priority, status (18), mode, scope_path, branch_mode, target_branch, work_branch, base_sha, related_task_id, extra_context, create_pr_on_completion, owner_id, summary_md, token_cap_override | Checks: existing ⇔ target_branch, relative scope_path, related task in same org (trigger). Never deleted (cancelled instead) |
| ✅ task_events | type, from_status, to_status, actor, payload | Append-only |
| ✅ task_documents | kind plan/lld, version, content_md (immutable), status, reviewer, comment | One pending per kind |
| ✅ task_questions | kind question/deviation, paths, answer, approved | One open per task |
| ✅ agent_runs | phase, status, transcript_key, state, resume_status, token and cost totals | System-written |
| ✅ agent_steps | seq, kind, tool_name, input/output (truncated), is_error | System-written |
| ✅ workspaces / workspace_files | base_sha, base_ref, revision; path, op, base_blob_sha, content (1 MB cap) | System-written |
| ✅ blobs | key, content (transcripts) | System role only; moves to S3 later |

## Builder (A-5)

| Table | | Notes |
|---|---|---|
| ✅ builders | owner, name, kind personal/team, allow_shared, token_hash (sha256), os/arch/cli_version, docker_available, limits, last_seen_at, revoked_at | The app role can't read token_hash |
| ✅ builder_repo_bindings | PK(builder_id, repo_id), local_path, first_run_confirmed_at | |
| ✅ builder_jobs | task, run, base_sha, workspace_revision, patch_key + sha256, config_snapshot (base branch), config_changed, consent, docker, final, fix_cycle, status, result, failed_tests, log_tail, log_key | System-written |

## Blob storage (R-1)

| Table | Notes |
|---|---|
| ✅ blobs | `hash` (sha256 hex, pk), `size`, `encoding` (`gzip` or `identity` for rows migrated from the old table), `content`. No org column: a blob is reachable only through a row in an org. System role only (migration 0018). |

Rows that point at blobs: `builder_jobs.patch_hash` (kept forever), `builder_jobs.log_hash` (cleared after `orgs.log_retention_days`), `agent_runs.transcript_hash` (cleared after `orgs.snapshot_retention_days` once the task is finished). Unreferenced blobs older than 24 h are deleted by the nightly sweep (04:00 UTC).

`orgs.log_retention_days` (7–365, default 30) and `orgs.snapshot_retention_days` (1–90, default 14) are set in Settings.

## PRs (A-6)

| Table | | Notes |
|---|---|---|
| ✅ pull_requests | task, repo, github_pr_id, number, url, head/base branch, head_sha, state open/closed/merged, created_by user/agent_on_completion/stale_job, merged_at | System-written; webhooks keep it in sync |

Also added on tasks: `change_notes`, `last_pushed_sha`, `last_pushed_at`, `stale_notified_at`.

## Repo chat, team room and Repo Agent (B-2)

| Table | Columns that matter | Notes |
|---|---|---|
| ✅ chat_sessions | org, repo, user (author), title | Private chat (was `repo_chats`, renamed in 0022). RLS `chat_sessions_owner` |
| ✅ chat_messages | session, user, role user/assistant, status pending/done/failed, content, reply_to, citations [{path, startLine?, endLine?}], commit_sha, error | Was `repo_chat_messages`; `sources` (paths) became `citations` in 0022. RLS `chat_messages_owner` |
| ✅ repo_channels | org, repo (unique) | The team room, created on first use |
| ✅ channel_messages | channel, repo, author user/agent, user, status, content, reply_to, citations, commit_sha, error | For an agent message, `user` is who mentioned it. No deletes by the app role |
| ✅ repo_agent_memory | org, repo, section (conventions, architecture, rules, fragile_areas), content_md ≤ 8000, updated_by | Unique per repo and section |

Room and memory tables use RLS `repo_readers` (migration 0023): inside the org **and** the user has
a `user_repo_access` row for the repo. `llm_use_case` value `chat` (default `claude-sonnet-5-5`, no
per-task cap; monthly budgets apply). Realtime: `chat.message` (to the author), `channel.message`
and `repo_agent.memory_updated` (to the repo topic).

## Code index (B-2 part 2)

| Table | Columns that matter | Notes |
|---|---|---|
| ✅ code_chunks | org, repo, path, blob_sha, start_line, end_line (1-based), language, symbol, content, tsv (tsvector, `simple`), embedding vector(768) | One function, class or line window of a default-branch file. HNSW (cosine) on embedding, GIN on tsv. Written only by the worker; RLS `repo_readers`, app role has SELECT only |
| ✅ code_index_state | repo (pk), org, status pending/indexing/ready/failed, commit_sha, model, files, chunks, skipped_files, error, started_at, finished_at | One row per indexed repo. Realtime trigger → `code_index.status`. RLS `repo_readers`, SELECT only |

Both are stored only while `orgs.settings.storeCodeIndex` is true; turning it off deletes every
row of the org. A different embedding `model` than the one recorded means a full re-index.

## Cross-repo sync (B-3)

| Table | Columns that matter | Notes |
|---|---|---|
| ✅ repo_links | org, source_repo, target_repo, two_way, mapping_notes_md ≤ 8000, created_by | One link per pair in either direction (unique on least/greatest), no self-links. RLS `repo_readers`: read with access to either repo, write with access to both; admin-only in the API |
| ✅ tasks (added) | source_task_id, source_context_md ≤ 60000 | The task a port came from, and the frozen change, PR and mapping notes it was created with (migration 0025) |

## Prompt guide (B-1)

| Table | Columns that matter | Notes |
|---|---|---|
| ✅ prompt_templates | org, name (unique per org), kind (bug_fix, feature, refactor, add_tests, ui_change), description_md, acceptance_criteria_md, created_by | The org's own templates; the five built-ins live in code (`@autodev/protocol` prompt-check). RLS `tenant_isolation`; only admins change them (API) |
| ✅ tasks (added) | prompt_score 0–100, prompt_score_details {version, flags}, prompt_checked_at | The rule-based score, recomputed on create and edit (migration 0021) |

`llm_use_case` value `prompt_guide` (migration 0016) was renamed to `prompt_check` in 0021 with
`RENAME VALUE`, so existing policies and usage rows keep working. Default model: `claude-sonnet-5-5`.

## Section A tables still to come

None: every Section A table exists. Section B (repo chat, prompt guide, sync, leaderboard, group
agent, billing, SSO) adds its own.

## Cross-cutting

| Table | Notes |
|---|---|
| ✅ notifications | Read your own; create for anyone in the org |
| ✅ audit_log | Append-only: the app role has INSERT/SELECT only, and a trigger rejects UPDATE/DELETE for every role |
