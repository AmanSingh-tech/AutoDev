import { and, eq } from 'drizzle-orm';
import type { SystemDb, Tx } from '../client';
import { taskEvents, tasks } from '../schema';
import type { TaskStatus } from '../schema/enums';
import { assertTransition, TERMINAL_STATUSES } from '../task-machine';

export interface Actor {
  type: 'user' | 'agent' | 'system' | 'builder';
  userId: string | null;
}

export class TaskConflict extends Error {
  override name = 'TaskConflict';
  constructor() {
    super('The task changed in the meantime. Refresh and try again.');
  }
}

/**
 * The one way to change a task's status. It checks the state machine, does a compare-and-set on
 * the current status (so concurrent actors can't both win), and appends the event.
 */
export async function transitionTask(
  tx: Tx | SystemDb,
  task: { id: string; orgId: string; status: TaskStatus },
  to: TaskStatus,
  actor: Actor,
  payload: Record<string, unknown> = {},
) {
  assertTransition(task.status, to);
  const [updated] = await tx
    .update(tasks)
    .set({ status: to, completedAt: TERMINAL_STATUSES.includes(to) ? new Date() : null })
    .where(and(eq(tasks.id, task.id), eq(tasks.orgId, task.orgId), eq(tasks.status, task.status)))
    .returning();
  if (!updated) throw new TaskConflict();
  const [event] = await tx
    .insert(taskEvents)
    .values({ orgId: task.orgId, taskId: task.id, actorType: actor.type, actorUserId: actor.userId, type: 'status_changed', fromStatus: task.status, toStatus: to, payload })
    .returning({ id: taskEvents.id });
  return { task: updated, eventId: event!.id };
}

export async function recordTaskEvent(tx: Tx | SystemDb, e: { orgId: string; taskId: string; actor: Actor; type: string; payload?: Record<string, unknown> }) {
  await tx.insert(taskEvents).values({ orgId: e.orgId, taskId: e.taskId, actorType: e.actor.type, actorUserId: e.actor.userId, type: e.type, payload: e.payload ?? {} });
}
