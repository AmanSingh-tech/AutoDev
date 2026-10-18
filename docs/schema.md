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

Later in A-4: task_documents (plan|lld, version, status,
reviewer, comment), task_questions, agent_runs, agent_steps, workspaces, workspace_files.

## Builder and PRs (A-5, A-6)

builders, builder_repo_bindings, builder_jobs, pull_requests (created_by user | agent_on_completion | stale_job).

## Cross-cutting

| Table | Notes |
|---|---|
| ✅ notifications | Read your own; create for anyone in the org |
| ✅ audit_log | Append-only: the app role has INSERT/SELECT only, and a trigger rejects UPDATE/DELETE for every role |
