import {
  ORG_ADMIN_TOPIC,
  repoTopic,
  taskTopic,
  userTopic,
  type EventType,
} from '@autodev/protocol';
import type { TypedEvent } from './emit';

/**
 * One committed row change, as sent by the notify_row_change() trigger (migration 0020). Only the
 * columns each table lists in its trigger are present in `new` and `old`.
 */
export interface RowChange {
  t: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  txid: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

/** An event to publish, with the key that makes it publish once however many processes see it. */
export type PlannedEvent = { [T in EventType]: TypedEvent<T> & { dedupe: string } }[EventType];

const TERMINAL_JOB = new Set(['passed', 'failed', 'timed_out', 'error', 'skipped']);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const changed = (n: Record<string, unknown>, o: Record<string, unknown>, k: string) =>
  n[k] !== o[k];

/** Maps a row change to catalogue events. Pure: no database, no Redis. */
export function eventsForChange(c: RowChange): PlannedEvent[] {
  const n = c.new ?? {};
  const o = c.old ?? {};
  const orgId = str(n.org_id) ?? str(o.org_id);
  if (!orgId) return [];
  const rowKey = str(n.id) ?? str(o.id) ?? str(n.user_id) ?? str(o.user_id) ?? '';
  const out: PlannedEvent[] = [];
  const add = <T extends EventType>(
    type: T,
    topic: string,
    payload: TypedEvent<T>['payload'],
    dedupe?: string,
  ) =>
    out.push({
      type,
      topic,
      orgId,
      payload,
      dedupe: dedupe ?? `${c.txid}:${c.t}:${c.op}:${rowKey}:${type}:${topic}`,
    } as PlannedEvent);

  const taskId = str(n.task_id) ?? str(o.task_id);
  const onTask = taskId ? taskTopic(taskId) : null;

  switch (c.t) {
    case 'tasks': {
      const id = (str(n.id) ?? str(o.id))!;
      const repoId = (str(n.repo_id) ?? str(o.repo_id))!;
      if (c.op === 'INSERT')
        add('task.created', repoTopic(repoId), { taskId: id, key: String(n.key) });
      if (c.op === 'DELETE') add('task.deleted', repoTopic(repoId), { taskId: id });
      if (c.op === 'UPDATE') {
        const statusChanged = changed(n, o, 'status');
        const pushed = !!n.last_pushed_sha && changed(n, o, 'last_pushed_sha');
        if (statusChanged) {
          const move = { taskId: id, from: String(o.status), to: String(n.status) };
          add('task.status', taskTopic(id), move);
          add('task.moved', repoTopic(repoId), move);
          if (n.status === 'blocked_on_key')
            add('task.blocked_on_key', taskTopic(id), { taskId: id });
        }
        if (pushed)
          add('branch.pushed', taskTopic(id), {
            taskId: id,
            sha: String(n.last_pushed_sha),
            branch: String(n.work_branch),
          });
        if (!statusChanged && !pushed) add('task.updated', taskTopic(id), { taskId: id });
      }
      break;
    }
    case 'agent_steps':
      if (onTask && c.op === 'INSERT') {
        add('agent.step', onTask, {
          taskId: taskId!,
          runId: String(n.agent_run_id),
          stepId: String(n.id),
          kind: String(n.kind),
          toolName: str(n.tool_name),
        });
      }
      break;
    case 'task_questions':
      if (!onTask) break;
      if (c.op === 'INSERT')
        add(n.kind === 'deviation' ? 'agent.deviation' : 'agent.question', onTask, {
          taskId: taskId!,
          questionId: String(n.id),
        });
      if (c.op === 'UPDATE' && o.answered_at == null && n.answered_at != null) {
        add('agent.question_answered', onTask, {
          taskId: taskId!,
          questionId: String(n.id),
          approved: typeof n.approved === 'boolean' ? n.approved : null,
        });
      }
      break;
    case 'task_documents': {
      if (!onTask) break;
      const doc = {
        taskId: taskId!,
        docId: String(n.id),
        kind: n.kind as 'plan' | 'lld',
        version: Number(n.version),
      };
      if (c.op === 'INSERT') add('doc.ready', onTask, doc);
      if (c.op === 'UPDATE' && changed(n, o, 'status'))
        add('doc.reviewed', onTask, { ...doc, status: String(n.status) });
      break;
    }
    case 'builder_jobs': {
      if (!onTask) break;
      const job = { taskId: taskId!, jobId: String(n.id) };
      if (c.op === 'INSERT') {
        add('job.created', onTask, job);
        if (n.consent === 'pending') add('job.consent_required', onTask, job);
      }
      if (c.op === 'UPDATE') {
        if (changed(n, o, 'status')) {
          if (n.status === 'running') add('job.started', onTask, job);
          if (n.status === 'cancelled') add('job.cancelled', onTask, job);
          if (TERMINAL_JOB.has(String(n.status)))
            add('test.result', onTask, {
              ...job,
              status: String(n.status),
              exitCode: typeof n.exit_code === 'number' ? n.exit_code : null,
            });
        }
        if (n.consent === 'pending' && o.consent !== 'pending')
          add('job.consent_required', onTask, job);
        if (o.offline_notified_at == null && n.offline_notified_at != null)
          add('job.queued_offline', onTask, job);
      }
      break;
    }
    case 'pull_requests': {
      if (!onTask) break;
      const pr = { taskId: taskId!, prId: String(n.id), number: Number(n.number) };
      if (c.op === 'INSERT') add('pr.opened', onTask, { ...pr, url: String(n.url) });
      if (c.op === 'UPDATE') {
        if (changed(n, o, 'state') && n.state === 'merged') add('pr.merged', onTask, pr);
        else if (changed(n, o, 'state') && n.state === 'closed') add('pr.closed', onTask, pr);
        else if (n.state === 'open' && (changed(n, o, 'head_sha') || changed(n, o, 'state')))
          add('pr.updated', onTask, { ...pr, headSha: String(n.head_sha ?? '') });
      }
      break;
    }
    case 'agent_runs':
      if (onTask && c.op === 'UPDATE' && n.status === 'failed' && o.status !== 'failed')
        add('run.failed', onTask, { taskId: taskId!, runId: String(n.id) });
      break;
    case 'token_usage':
      if (onTask && c.op === 'INSERT') {
        add('usage.tick', onTask, {
          taskId: taskId!,
          inputTokens: Number(n.input_tokens ?? 0),
          outputTokens: Number(n.output_tokens ?? 0),
          costUsd: String(n.cost_usd ?? '0'),
        });
      }
      break;
    case 'notifications': {
      if (c.op !== 'INSERT' || !str(n.user_id)) break;
      const user = userTopic(String(n.user_id));
      add('notification', user, {
        notificationId: String(n.id),
        type: String(n.type),
        title: String(n.title ?? ''),
      });
      const budgetType =
        n.type === 'budget.soft_limit'
          ? 'budget.warning'
          : n.type === 'budget.hard_limit'
            ? 'budget.exceeded'
            : null;
      if (budgetType) {
        const p = (n.payload ?? {}) as {
          scope?: 'org' | 'user';
          userId?: string | null;
          spentUsd?: number;
        };
        const budget = {
          scope: p.scope ?? 'org',
          userId: p.userId ?? null,
          spentUsd: Number(p.spentUsd ?? 0),
        };
        add(budgetType, user, budget);
        // Every admin gets a notification row in the same transaction; admins see it once.
        add(
          budgetType,
          ORG_ADMIN_TOPIC,
          budget,
          `${c.txid}:budget:${budgetType}:${budget.scope}:${budget.userId ?? ''}`,
        );
      }
      break;
    }
    case 'builders': {
      const owner = str(n.owner_user_id) ?? str(o.owner_user_id);
      if (!owner) break;
      if (c.op === 'INSERT') add('builder.paired', userTopic(owner), { builderId: String(n.id) });
      if (c.op === 'UPDATE' && o.revoked_at == null && n.revoked_at != null)
        add('builder.revoked', userTopic(owner), { builderId: String(n.id) });
      break;
    }
    case 'user_repo_access': {
      const user = str(n.user_id) ?? str(o.user_id);
      // A refresh rewrites many rows in one transaction; one event per user is enough.
      if (user)
        add(
          'repo_access.changed',
          userTopic(user),
          { userId: user },
          `${c.txid}:repo_access:${user}`,
        );
      break;
    }
    case 'llm_credentials':
      if (c.op === 'INSERT' || changed(n, o, 'status'))
        add('credential.status', ORG_ADMIN_TOPIC, {
          credentialId: String(n.id),
          status: String(n.status),
          scope: String(n.scope),
        });
      break;
    case 'installations':
      if (c.op !== 'DELETE')
        add('installation.changed', ORG_ADMIN_TOPIC, { installationId: String(n.id) });
      break;
    case 'org_members': {
      const user = String(n.user_id ?? o.user_id);
      if (c.op === 'INSERT' && n.status === 'active')
        add('member.joined', ORG_ADMIN_TOPIC, { userId: user });
      if (c.op === 'UPDATE' && changed(n, o, 'status'))
        add(n.status === 'active' ? 'member.joined' : 'member.left', ORG_ADMIN_TOPIC, {
          userId: user,
        });
      break;
    }
  }
  return out;
}
