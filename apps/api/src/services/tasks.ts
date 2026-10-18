import { InvalidTransition, recordTaskEvent, TaskConflict, transitionTask, type Actor, type SystemDb, type TaskStatus, type Tx } from '@autodev/db';
import { TRPCError } from '@trpc/server';

export type { Actor };

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

/** transitionTask with domain errors mapped to tRPC codes. */
export async function transition(tx: Tx | SystemDb, task: { id: string; orgId: string; status: TaskStatus }, to: TaskStatus, actor: Actor, payload: Record<string, unknown> = {}) {
  try {
    return await transitionTask(tx, task, to, actor, payload);
  } catch (e) {
    if (e instanceof InvalidTransition) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
    if (e instanceof TaskConflict) throw new TRPCError({ code: 'CONFLICT', message: e.message });
    throw e;
  }
}

export const recordEvent = (tx: Tx, e: Parameters<typeof recordTaskEvent>[1]) => recordTaskEvent(tx, e);
