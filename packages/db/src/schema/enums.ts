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
export const llmProvider = pgEnum('llm_provider', ['anthropic', 'openai', 'azure_openai', 'bedrock']);
export const credentialScope = pgEnum('credential_scope', ['org', 'team', 'user']);
export const credentialStatus = pgEnum('credential_status', ['active', 'invalid', 'superseded', 'revoked']);
/** Section B adds more use cases (repo chat, prompt guide…). Postgres enums can be extended in place. */
export const llmUseCase = pgEnum('llm_use_case', ['agent', 'chat', 'prompt_guide']);
export const chatRole = pgEnum('chat_role', ['user', 'assistant']);
export const chatMessageStatus = pgEnum('chat_message_status', ['pending', 'done', 'failed']);
export const budgetScope = pgEnum('budget_scope', ['org', 'user']);
export const taskStatus = pgEnum('task_status', [
  'draft',
  'queued',
  'planning',
  'awaiting_plan_approval',
  'designing',
  'awaiting_lld_approval',
  'coding',
  'waiting_for_builder',
  'testing',
  'fixing',
  'needs_input',
  'blocked_on_key',
  'pushed',
  'pr_open',
  'resolved',
  'rejected',
  'failed',
  'cancelled',
]);
export const taskPriority = pgEnum('task_priority', ['low', 'medium', 'high', 'urgent']);
export const branchMode = pgEnum('branch_mode', ['new', 'existing']);
export const documentKind = pgEnum('document_kind', ['plan', 'lld']);
export const documentStatus = pgEnum('document_status', ['pending_review', 'approved', 'changes_requested', 'rejected', 'superseded']);
export const questionKind = pgEnum('question_kind', ['question', 'deviation']);
export const agentPhase = pgEnum('agent_phase', ['plan', 'lld', 'code', 'fix']);
export const agentRunStatus = pgEnum('agent_run_status', ['running', 'paused', 'succeeded', 'failed', 'cancelled']);
export const agentStepKind = pgEnum('agent_step_kind', ['llm_call', 'tool_call', 'message']);
export const workspaceFileOp = pgEnum('workspace_file_op', ['create', 'modify', 'delete']);
export const builderKind = pgEnum('builder_kind', ['personal', 'team']);
export const builderJobStatus = pgEnum('builder_job_status', ['queued', 'offered', 'running', 'passed', 'failed', 'timed_out', 'error', 'skipped', 'cancelled']);
export const jobConsent = pgEnum('job_consent', ['not_needed', 'pending', 'granted', 'denied']);
export const prState = pgEnum('pr_state', ['open', 'closed', 'merged']);
export const prCreatedBy = pgEnum('pr_created_by', ['user', 'agent_on_completion', 'stale_job']);

export const ORG_ROLES = orgRole.enumValues;
export type LlmProviderId = (typeof llmProvider.enumValues)[number];
export type CredentialScope = (typeof credentialScope.enumValues)[number];
export const LLM_USE_CASES = llmUseCase.enumValues;
export const TASK_STATUSES = taskStatus.enumValues;
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export const TASK_PRIORITIES = taskPriority.enumValues;
export type TaskPriority = (typeof taskPriority.enumValues)[number];
export const TASK_MODES = taskMode.enumValues;
export type DocumentKind = (typeof documentKind.enumValues)[number];
export type AgentPhase = (typeof agentPhase.enumValues)[number];
export type LlmUseCase = (typeof llmUseCase.enumValues)[number];
export type OrgRole = (typeof ORG_ROLES)[number];
export type TaskMode = (typeof taskMode.enumValues)[number];
export type RepoPermission = (typeof repoPermission.enumValues)[number];

/** Permissions that let a user push, which is what the repo list and every push require. */
export const WRITE_PERMISSIONS: readonly RepoPermission[] = ['admin', 'maintain', 'push'];
