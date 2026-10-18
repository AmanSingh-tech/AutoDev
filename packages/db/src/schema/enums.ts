import { pgEnum } from 'drizzle-orm/pg-core';

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'developer', 'viewer']);
export const memberStatus = pgEnum('member_status', ['active', 'removed']);
export const accountType = pgEnum('github_account_type', ['Organization', 'User']);
export const taskMode = pgEnum('task_mode', ['plan_lld', 'plan_only', 'direct']);
export const staleBranchAction = pgEnum('stale_branch_action', ['auto_open_pr', 'notify_owner']);
export const repoPermission = pgEnum('repo_permission', [
  'admin',
  'maintain',
  'push',
  'triage',
  'pull',
]);
export const actorType = pgEnum('actor_type', ['user', 'agent', 'system', 'builder']);

export const ORG_ROLES = orgRole.enumValues;
export type OrgRole = (typeof ORG_ROLES)[number];
export type TaskMode = (typeof taskMode.enumValues)[number];
export type RepoPermission = (typeof repoPermission.enumValues)[number];

/** Permissions that let a user push, which is what the repo list and every push require. */
export const WRITE_PERMISSIONS: readonly RepoPermission[] = ['admin', 'maintain', 'push'];
