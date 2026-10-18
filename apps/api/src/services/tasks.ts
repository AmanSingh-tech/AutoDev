import { and, assertTransition, eq, InvalidTransition, schema, TERMINAL_STATUSES, type TaskStatus, type Tx } from '@autodev/db';
import { TRPCError } from '@trpc/server';

const { taskEvents, tasks } = schema;

export interface Actor {
  type: 'user' | 'agent' | 'system' | 'builder';
  userId: string | null;
}

/** Repo-relative folder: strips "./" and slashes; rejects absolute paths, "..", backslashes. */
export function normalizeScopePath(input: string | null | undefined): string | null {
  if (input == null) return null;
  const p = input.trim().replace(/^\.\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!p || p === '.') return null;
  if (p.startsWith('/') || p.includes('\\') || p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Scope path must be a folder inside the repo, like "packages/web"' });
  }
  if (p.length > 300) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Scope path is too long' });
  return p;
}

/**
 * Moves a task to a new status if the state machine allows it, with a compare-and-set on the
 * current status so two concurrent actors can't both win, and records the event.
 */
export async function transition(
  tx: Tx,
  task: { id: string; orgId: string; status: TaskStatus },
  to: TaskStatus,
  actor: Actor,
  payload: Record<string, unknown> = {},
) {
  try {
    assertTransition(task.status, to);
  } catch (e) {
    if (e instanceof InvalidTransition) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
    throw e;
  }
  const [updated] = await tx
    .update(tasks)
    .set({ status: to, completedAt: TERMINAL_STATUSES.includes(to) ? new Date() : null })
    .where(and(eq(tasks.id, task.id), eq(tasks.orgId, task.orgId), eq(tasks.status, task.status)))
    .returning();
  if (!updated) throw new TRPCError({ code: 'CONFLICT', message: 'The task changed in the meantime. Refresh and try again.' });
  const [event] = await tx
    .insert(taskEvents)
    .values({
      orgId: task.orgId,
      taskId: task.id,
      actorType: actor.type,
      actorUserId: actor.userId,
      type: 'status_changed',
      fromStatus: task.status,
      toStatus: to,
      payload,
    })
    .returning({ id: taskEvents.id });
  return { task: updated, eventId: event!.id };
}

export async function recordEvent(tx: Tx, e: { orgId: string; taskId: string; actor: Actor; type: string; payload?: Record<string, unknown> }) {
  await tx.insert(taskEvents).values({
    orgId: e.orgId,
    taskId: e.taskId,
    actorType: e.actor.type,
    actorUserId: e.actor.userId,
    type: e.type,
    payload: e.payload ?? {},
  });
}
