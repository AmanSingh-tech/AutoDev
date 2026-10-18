import type { TaskMode, TaskStatus } from './schema/enums';

/**
 * Every allowed status change in Section A. The API, the agent worker (A-4), the builder flow
 * (A-5) and PR webhooks (A-6) all go through `assertTransition`, so the rules live in one place.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['draft', 'planning', 'coding', 'blocked_on_key', 'cancelled'],
  planning: ['awaiting_plan_approval', 'needs_input', 'blocked_on_key', 'failed', 'cancelled'],
  awaiting_plan_approval: ['planning', 'designing', 'coding', 'rejected', 'cancelled'],
  designing: ['awaiting_lld_approval', 'needs_input', 'blocked_on_key', 'failed', 'cancelled'],
  awaiting_lld_approval: ['designing', 'coding', 'rejected', 'cancelled'],
  coding: ['waiting_for_builder', 'testing', 'needs_input', 'blocked_on_key', 'failed', 'cancelled'],
  waiting_for_builder: ['testing', 'cancelled'],
  // coding: results of a mid-coding test run go back to the agent. waiting_for_builder: the builder dropped.
  testing: ['fixing', 'coding', 'waiting_for_builder', 'pushed', 'failed', 'cancelled'],
  fixing: ['waiting_for_builder', 'testing', 'needs_input', 'blocked_on_key', 'failed', 'cancelled'],
  needs_input: ['planning', 'designing', 'coding', 'fixing', 'cancelled'],
  blocked_on_key: ['planning', 'designing', 'coding', 'fixing', 'cancelled'],
  pushed: ['pr_open', 'resolved', 'failed'],
  pr_open: ['resolved', 'cancelled'],
  resolved: [],
  rejected: [],
  // A failed task can be retried from the queue, or (after a failed push) retry just the push.
  failed: ['queued', 'testing'],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['resolved', 'rejected', 'failed', 'cancelled'];

export const canTransition = (from: TaskStatus, to: TaskStatus) => TRANSITIONS[from].includes(to);

export class InvalidTransition extends Error {
  override name = 'InvalidTransition';
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`A task can't go from ${from} to ${to}`);
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus) {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
}

/** Where the agent starts a run for each mode. */
export const FIRST_PHASE: Record<TaskMode, TaskStatus> = { plan_lld: 'planning', plan_only: 'planning', direct: 'coding' };

/** Board columns group the 18 statuses into what a person needs to know. */
export const BOARD_COLUMNS = [
  { id: 'draft', label: 'Draft', statuses: ['draft'] },
  { id: 'queued', label: 'Queued', statuses: ['queued', 'waiting_for_builder'] },
  { id: 'in_progress', label: 'In progress', statuses: ['planning', 'designing', 'coding', 'testing', 'fixing'] },
  { id: 'needs_you', label: 'Needs you', statuses: ['awaiting_plan_approval', 'awaiting_lld_approval', 'needs_input', 'blocked_on_key'] },
  { id: 'pr', label: 'Pushed / PR', statuses: ['pushed', 'pr_open'] },
  { id: 'done', label: 'Done', statuses: ['resolved', 'rejected', 'failed', 'cancelled'] },
] as const satisfies readonly { id: string; label: string; statuses: readonly TaskStatus[] }[];

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]['id'];

export const columnOf = (s: TaskStatus): BoardColumnId => BOARD_COLUMNS.find((c) => (c.statuses as readonly TaskStatus[]).includes(s))!.id;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  planning: 'Planning',
  awaiting_plan_approval: 'Plan ready for review',
  designing: 'Designing',
  awaiting_lld_approval: 'Design ready for review',
  coding: 'Coding',
  waiting_for_builder: 'Waiting for your builder',
  testing: 'Testing',
  fixing: 'Fixing test failures',
  needs_input: 'Question for you',
  blocked_on_key: 'Blocked: LLM key',
  pushed: 'Pushed',
  pr_open: 'PR open',
  resolved: 'Resolved',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
