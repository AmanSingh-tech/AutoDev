import { EVENT_TOPIC_KINDS, eventPayloads, type EventType } from '@autodev/protocol';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { eventsForChange, type RowChange } from './changes';
import { emit } from './emit';

const ORG = '0192f1a2-0000-7000-8000-000000000001';
const TASK = '0192f1a2-0000-7000-8000-000000000002';
const REPO = '0192f1a2-0000-7000-8000-000000000003';
const ROW = '0192f1a2-0000-7000-8000-000000000004';
const USER = '0192f1a2-0000-7000-8000-000000000005';
const RUN = '0192f1a2-0000-7000-8000-000000000006';

const change = (
  t: string,
  op: RowChange['op'],
  n: Record<string, unknown> | null,
  o: Record<string, unknown> | null = null,
  txid = '100',
): RowChange => ({
  t,
  op,
  txid,
  new: n && { org_id: ORG, ...n },
  old: o && { org_id: ORG, ...o },
});
const types = (c: RowChange) => eventsForChange(c).map((e) => `${e.type}@${e.topic.split(':')[0]}`);

/** The catalogue from the R-3 decision, by group. */
const SPEC: Record<string, EventType[]> = {
  task: [
    'task.status',
    'task.updated',
    'agent.step',
    'agent.question',
    'agent.question_answered',
    'agent.deviation',
    'doc.ready',
    'doc.reviewed',
    'job.created',
    'job.queued_offline',
    'job.started',
    'job.consent_required',
    'test.log',
    'test.result',
    'job.cancelled',
    'branch.pushed',
    'pr.opened',
    'pr.updated',
    'pr.merged',
    'pr.closed',
    'run.failed',
    'usage.tick',
    'task.blocked_on_key',
  ],
  repo: ['task.created', 'task.moved', 'task.deleted'],
  user: [
    'notification',
    'builder.presence',
    'builder.paired',
    'builder.revoked',
    'repo_access.changed',
    'budget.warning',
    'budget.exceeded',
  ],
  'org:admin': [
    'credential.status',
    'budget.warning',
    'budget.exceeded',
    'stale_branch.found',
    'installation.changed',
    'member.joined',
    'member.left',
  ],
};

describe('the catalogue', () => {
  it('has exactly the agreed events, each in the agreed groups', () => {
    const agreed = new Set(Object.values(SPEC).flat());
    expect(new Set(Object.keys(eventPayloads))).toEqual(agreed);
    for (const [group, events] of Object.entries(SPEC)) {
      for (const type of events) expect(EVENT_TOPIC_KINDS[type]).toContain(group);
    }
  });
});

describe('emit', () => {
  const redis = {} as Redis; // never reached: both calls fail validation first

  it('refuses an event on a topic of the wrong kind', async () => {
    await expect(
      emit(redis, {
        type: 'task.status',
        orgId: ORG,
        topic: `repo:${REPO}`,
        payload: { taskId: TASK, from: 'a', to: 'b' },
      }),
    ).rejects.toThrow(/can't be sent/);
  });

  it('refuses a payload that does not match the schema', async () => {
    await expect(
      emit(redis, {
        type: 'task.status',
        orgId: ORG,
        topic: `task:${TASK}`,
        payload: { taskId: 'nope' } as never,
      }),
    ).rejects.toThrow();
  });
});

describe('eventsForChange', () => {
  it('tasks: created on the board, status as task + board events, pushes, edits, deletes', () => {
    const base = {
      id: TASK,
      repo_id: REPO,
      key: 'AD-1',
      work_branch: 'autodev/AD-1-x',
      last_pushed_sha: null,
    };
    expect(types(change('tasks', 'INSERT', { ...base, status: 'draft' }))).toEqual([
      'task.created@repo',
    ]);
    expect(
      types(change('tasks', 'UPDATE', { ...base, status: 'queued' }, { ...base, status: 'draft' })),
    ).toEqual(['task.status@task', 'task.moved@repo']);
    expect(
      types(
        change(
          'tasks',
          'UPDATE',
          { ...base, status: 'blocked_on_key' },
          { ...base, status: 'coding' },
        ),
      ),
    ).toEqual(['task.status@task', 'task.moved@repo', 'task.blocked_on_key@task']);
    expect(
      types(
        change(
          'tasks',
          'UPDATE',
          { ...base, status: 'pushed', last_pushed_sha: 'abc' },
          { ...base, status: 'testing' },
        ),
      ),
    ).toEqual(['task.status@task', 'task.moved@repo', 'branch.pushed@task']);
    expect(
      types(change('tasks', 'UPDATE', { ...base, status: 'draft' }, { ...base, status: 'draft' })),
    ).toEqual(['task.updated@task']);
    expect(types(change('tasks', 'DELETE', null, { ...base, status: 'draft' }))).toEqual([
      'task.deleted@repo',
    ]);
  });

  it('agent steps, questions, deviations, answers and documents', () => {
    expect(
      types(
        change('agent_steps', 'INSERT', {
          id: ROW,
          task_id: TASK,
          agent_run_id: RUN,
          kind: 'tool_call',
          tool_name: 'read_file',
        }),
      ),
    ).toEqual(['agent.step@task']);
    expect(
      types(change('task_questions', 'INSERT', { id: ROW, task_id: TASK, kind: 'question' })),
    ).toEqual(['agent.question@task']);
    expect(
      types(change('task_questions', 'INSERT', { id: ROW, task_id: TASK, kind: 'deviation' })),
    ).toEqual(['agent.deviation@task']);
    expect(
      types(
        change(
          'task_questions',
          'UPDATE',
          { id: ROW, task_id: TASK, answered_at: '2026-10-19', approved: true },
          { id: ROW, task_id: TASK, answered_at: null },
        ),
      ),
    ).toEqual(['agent.question_answered@task']);
    expect(
      types(
        change('task_documents', 'INSERT', {
          id: ROW,
          task_id: TASK,
          kind: 'plan',
          version: 1,
          status: 'pending',
        }),
      ),
    ).toEqual(['doc.ready@task']);
    expect(
      types(
        change(
          'task_documents',
          'UPDATE',
          { id: ROW, task_id: TASK, kind: 'plan', version: 1, status: 'approved' },
          { id: ROW, task_id: TASK, kind: 'plan', version: 1, status: 'pending' },
        ),
      ),
    ).toEqual(['doc.reviewed@task']);
  });

  it('builder jobs through their life', () => {
    const job = {
      id: ROW,
      task_id: TASK,
      consent: 'not_needed',
      offline_notified_at: null,
      exit_code: null,
    };
    expect(
      types(change('builder_jobs', 'INSERT', { ...job, status: 'queued', consent: 'pending' })),
    ).toEqual(['job.created@task', 'job.consent_required@task']);
    expect(
      types(
        change(
          'builder_jobs',
          'UPDATE',
          { ...job, status: 'queued', offline_notified_at: 'now' },
          { ...job, status: 'queued' },
        ),
      ),
    ).toEqual(['job.queued_offline@task']);
    expect(
      types(
        change(
          'builder_jobs',
          'UPDATE',
          { ...job, status: 'running' },
          { ...job, status: 'offered' },
        ),
      ),
    ).toEqual(['job.started@task']);
    expect(
      types(
        change(
          'builder_jobs',
          'UPDATE',
          { ...job, status: 'failed', exit_code: 1 },
          { ...job, status: 'running' },
        ),
      ),
    ).toEqual(['test.result@task']);
    expect(
      types(
        change(
          'builder_jobs',
          'UPDATE',
          { ...job, status: 'cancelled' },
          { ...job, status: 'queued' },
        ),
      ),
    ).toEqual(['job.cancelled@task']);
    const [result] = eventsForChange(
      change(
        'builder_jobs',
        'UPDATE',
        { ...job, status: 'passed', exit_code: 0 },
        { ...job, status: 'running' },
      ),
    );
    expect(result!.payload).toEqual({ taskId: TASK, jobId: ROW, status: 'passed', exitCode: 0 });
  });

  it('pull requests, failed runs and usage', () => {
    const pr = {
      id: ROW,
      task_id: TASK,
      number: 7,
      url: 'https://github.com/a/b/pull/7',
      head_sha: 'a',
    };
    expect(types(change('pull_requests', 'INSERT', { ...pr, state: 'open' }))).toEqual([
      'pr.opened@task',
    ]);
    expect(
      types(
        change(
          'pull_requests',
          'UPDATE',
          { ...pr, state: 'open', head_sha: 'b' },
          { ...pr, state: 'open' },
        ),
      ),
    ).toEqual(['pr.updated@task']);
    expect(
      types(
        change('pull_requests', 'UPDATE', { ...pr, state: 'merged' }, { ...pr, state: 'open' }),
      ),
    ).toEqual(['pr.merged@task']);
    expect(
      types(
        change('pull_requests', 'UPDATE', { ...pr, state: 'closed' }, { ...pr, state: 'open' }),
      ),
    ).toEqual(['pr.closed@task']);
    expect(
      types(
        change(
          'agent_runs',
          'UPDATE',
          { id: RUN, task_id: TASK, status: 'failed' },
          { id: RUN, task_id: TASK, status: 'running' },
        ),
      ),
    ).toEqual(['run.failed@task']);
    expect(
      types(
        change(
          'agent_runs',
          'UPDATE',
          { id: RUN, task_id: TASK, status: 'succeeded' },
          { id: RUN, task_id: TASK, status: 'running' },
        ),
      ),
    ).toEqual([]);
    expect(
      types(
        change('token_usage', 'INSERT', {
          id: ROW,
          task_id: TASK,
          input_tokens: 10,
          output_tokens: 2,
          cost_usd: '0.001000',
        }),
      ),
    ).toEqual(['usage.tick@task']);
    expect(
      types(
        change('token_usage', 'INSERT', {
          id: ROW,
          task_id: null,
          input_tokens: 10,
          output_tokens: 2,
          cost_usd: '0',
        }),
      ),
    ).toEqual([]);
  });

  it('notifications, and budget alerts once for admins however many admins were notified', () => {
    expect(
      types(
        change('notifications', 'INSERT', {
          id: ROW,
          user_id: USER,
          type: 'key.invalid',
          title: 'x',
        }),
      ),
    ).toEqual(['notification@user']);
    const alert = (rowId: string, userId: string) =>
      eventsForChange(
        change(
          'notifications',
          'INSERT',
          {
            id: rowId,
            user_id: userId,
            type: 'budget.soft_limit',
            title: 'x',
            payload: { scope: 'org', userId: null, spentUsd: 80 },
          },
          null,
          '200',
        ),
      );
    const first = alert(ROW, USER);
    const second = alert(RUN, '0192f1a2-0000-7000-8000-000000000099');
    expect(first.map((e) => `${e.type}@${e.topic.split(':')[0]}`)).toEqual([
      'notification@user',
      'budget.warning@user',
      'budget.warning@org',
    ]);
    const adminKey = (es: typeof first) => es.find((e) => e.topic === 'org:admin')!.dedupe;
    expect(adminKey(first)).toBe(adminKey(second));
  });

  it('builders, repo access, credentials, installations and members', () => {
    expect(
      types(change('builders', 'INSERT', { id: ROW, owner_user_id: USER, revoked_at: null })),
    ).toEqual(['builder.paired@user']);
    expect(
      types(
        change(
          'builders',
          'UPDATE',
          { id: ROW, owner_user_id: USER, revoked_at: 'now' },
          { id: ROW, owner_user_id: USER, revoked_at: null },
        ),
      ),
    ).toEqual(['builder.revoked@user']);
    const a = eventsForChange(change('user_repo_access', 'INSERT', { user_id: USER }));
    const b = eventsForChange(change('user_repo_access', 'DELETE', null, { user_id: USER }));
    expect(a[0]!.type).toBe('repo_access.changed');
    expect(a[0]!.dedupe).toBe(b[0]!.dedupe); // one event per user per refresh
    expect(
      types(
        change(
          'llm_credentials',
          'UPDATE',
          { id: ROW, status: 'invalid', scope: 'org' },
          { id: ROW, status: 'active', scope: 'org' },
        ),
      ),
    ).toEqual(['credential.status@org']);
    expect(
      types(
        change(
          'llm_credentials',
          'UPDATE',
          { id: ROW, status: 'active', scope: 'org' },
          { id: ROW, status: 'active', scope: 'org' },
        ),
      ),
    ).toEqual([]);
    expect(types(change('installations', 'UPDATE', { id: ROW }, { id: ROW }))).toEqual([
      'installation.changed@org',
    ]);
    expect(types(change('org_members', 'INSERT', { user_id: USER, status: 'active' }))).toEqual([
      'member.joined@org',
    ]);
    expect(
      types(
        change(
          'org_members',
          'UPDATE',
          { user_id: USER, status: 'removed' },
          { user_id: USER, status: 'active' },
        ),
      ),
    ).toEqual(['member.left@org']);
  });

  it('ignores rows with no org, and every planned payload passes its schema', () => {
    expect(
      eventsForChange({ t: 'tasks', op: 'INSERT', txid: '1', new: { id: TASK }, old: null }),
    ).toEqual([]);
    const all = [
      change(
        'tasks',
        'UPDATE',
        {
          id: TASK,
          repo_id: REPO,
          key: 'AD-1',
          status: 'pushed',
          last_pushed_sha: 'abc',
          work_branch: 'b',
        },
        { id: TASK, repo_id: REPO, status: 'testing' },
      ),
      change('agent_steps', 'INSERT', {
        id: ROW,
        task_id: TASK,
        agent_run_id: RUN,
        kind: 'llm_call',
        tool_name: null,
      }),
      change('notifications', 'INSERT', {
        id: ROW,
        user_id: USER,
        type: 'budget.hard_limit',
        title: 't',
        payload: { scope: 'user', userId: USER, spentUsd: 100 },
      }),
    ].flatMap(eventsForChange);
    for (const e of all) expect(() => eventPayloads[e.type].parse(e.payload)).not.toThrow();
  });
});
