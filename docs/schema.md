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

llm_credentials (scope org/team/user, provider, secret_enc, last4, status, rotated_from_id),
model_policies (use_case, model, max_tokens_per_task), model_prices (org_id NULL = global),
budgets (org/user, limit_usd, soft_pct, hard_block), token_usage (**monthly partitions**, cost
frozen at write time).

## Tasks and agent (A-3, A-4)

tasks (key AD-142, 18 statuses, mode, scope_path, branch_mode, target_branch, related_task_id,
create_pr_on_completion), task_events (append-only), task_documents (plan|lld, version, status,
reviewer, comment), task_questions, agent_runs, agent_steps, workspaces, workspace_files.

## Builder and PRs (A-5, A-6)

builders, builder_repo_bindings, builder_jobs, pull_requests (created_by user | agent_on_completion | stale_job).

## Cross-cutting

| Table | Notes |
|---|---|
| ✅ notifications | Read your own; create for anyone in the org |
| ✅ audit_log | Append-only: the app role has INSERT/SELECT only, and a trigger rejects UPDATE/DELETE for every role |
