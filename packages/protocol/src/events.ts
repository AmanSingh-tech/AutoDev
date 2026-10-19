import { z } from 'zod';

/**
 * Every event the web app can receive. The envelope is the same on the wire, in Redis and in the
 * SSE stream. `id` is the Redis stream id, which is also the SSE `id:` used for replay.
 */
export const eventEnvelope = z.object({
  id: z.string(),
  type: z.string().min(1).max(64),
  /** The topic the event is routed by. Subscriptions must name this topic exactly. */
  topic: z.string().min(1).max(128),
  orgId: z.string().uuid(),
  ts: z.string(),
  payload: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof eventEnvelope>;

/**
 * Topics:
 *   task:<taskId>   one task's progress (members who can read its repo)
 *   repo:<repoId>   the board: tasks created, moved, deleted (members who can read the repo)
 *   user:<userId>   notifications and personal changes (only that user)
 *   org             org-wide changes (any active member)
 *   org:admin       admin-only changes (owners and admins)
 */
export const MAX_TOPICS_PER_STREAM = 20;

const uuid = z.string().uuid();
const topicSchema = z.union([
  z.string().regex(/^task:[0-9a-f-]{36}$/i, 'task:<id>'),
  z.string().regex(/^repo:[0-9a-f-]{36}$/i, 'repo:<id>'),
  z.string().regex(/^user:[0-9a-f-]{36}$/i, 'user:<id>'),
  z.literal('org'),
  z.literal('org:admin'),
]);

export type Topic = z.infer<typeof topicSchema>;

/** Parses `?topics=a,b,c`. Rejects unknown or duplicate topics and too many of them. */
export function parseTopics(raw: string): Topic[] {
  const parts = [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
  if (parts.length === 0) throw new Error('at least one topic is required');
  if (parts.length > MAX_TOPICS_PER_STREAM)
    throw new Error(`at most ${MAX_TOPICS_PER_STREAM} topics per stream`);
  return parts.map((t) => topicSchema.parse(t));
}

export const taskTopic = (taskId: string) => `task:${uuid.parse(taskId)}`;
export const repoTopic = (repoId: string) => `repo:${uuid.parse(repoId)}`;
export const userTopic = (userId: string) => `user:${uuid.parse(userId)}`;
export const ORG_TOPIC = 'org';
export const ORG_ADMIN_TOPIC = 'org:admin';

// ---------------------------------------------------------------------------------------------
// The catalogue: every event type, its payload, and the kinds of topic it may be sent on.

const id = uuid;
const taskBase = { taskId: id };
const budget = z.object({
  scope: z.enum(['org', 'user']),
  userId: id.nullable(),
  spentUsd: z.number(),
});

export const eventPayloads = {
  // task:<taskId>
  'task.status': z.object({ ...taskBase, from: z.string(), to: z.string() }),
  'task.updated': z.object(taskBase),
  'agent.step': z.object({
    ...taskBase,
    runId: id,
    stepId: id,
    kind: z.string(),
    toolName: z.string().nullable(),
  }),
  'agent.question': z.object({ ...taskBase, questionId: id }),
  'agent.question_answered': z.object({
    ...taskBase,
    questionId: id,
    approved: z.boolean().nullable(),
  }),
  'agent.deviation': z.object({ ...taskBase, questionId: id }),
  'doc.ready': z.object({
    ...taskBase,
    docId: id,
    kind: z.enum(['plan', 'lld']),
    version: z.number().int(),
  }),
  'doc.reviewed': z.object({
    ...taskBase,
    docId: id,
    kind: z.enum(['plan', 'lld']),
    version: z.number().int(),
    status: z.string(),
  }),
  'job.created': z.object({ ...taskBase, jobId: id }),
  'job.queued_offline': z.object({ ...taskBase, jobId: id }),
  'job.started': z.object({ ...taskBase, jobId: id }),
  'job.consent_required': z.object({ ...taskBase, jobId: id }),
  'test.log': z.object({ ...taskBase, jobId: id, text: z.string() }),
  'test.result': z.object({
    ...taskBase,
    jobId: id,
    status: z.string(),
    exitCode: z.number().int().nullable(),
  }),
  'job.cancelled': z.object({ ...taskBase, jobId: id }),
  'branch.pushed': z.object({ ...taskBase, sha: z.string(), branch: z.string() }),
  'pr.opened': z.object({ ...taskBase, prId: id, number: z.number().int(), url: z.string() }),
  'pr.updated': z.object({ ...taskBase, prId: id, number: z.number().int(), headSha: z.string() }),
  'pr.merged': z.object({ ...taskBase, prId: id, number: z.number().int() }),
  'pr.closed': z.object({ ...taskBase, prId: id, number: z.number().int() }),
  'run.failed': z.object({ ...taskBase, runId: id }),
  'usage.tick': z.object({
    ...taskBase,
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.string(),
  }),
  'task.blocked_on_key': z.object(taskBase),
  // repo:<repoId>
  'task.created': z.object({ ...taskBase, key: z.string() }),
  'task.moved': z.object({ ...taskBase, from: z.string(), to: z.string() }),
  'task.deleted': z.object(taskBase),
  'channel.message': z.object({ channelId: id, messageId: id, author: z.enum(['user', 'agent']), status: z.string() }),
  'repo_agent.memory_updated': z.object({ repoId: id, section: z.string() }),
  // user:<userId> (budget events also go to org:admin)
  notification: z.object({ notificationId: id, type: z.string(), title: z.string() }),
  'builder.presence': z.object({ builderId: id, online: z.boolean() }),
  'builder.paired': z.object({ builderId: id }),
  'builder.revoked': z.object({ builderId: id }),
  'repo_access.changed': z.object({ userId: id }),
  'chat.message': z.object({ sessionId: id, messageId: id, role: z.enum(['user', 'assistant']), status: z.string() }),
  'budget.warning': budget,
  'budget.exceeded': budget,
  // org:admin
  'credential.status': z.object({ credentialId: id, status: z.string(), scope: z.string() }),
  'stale_branch.found': z.object({ ...taskBase, repoId: id, days: z.number().int() }),
  'installation.changed': z.object({ installationId: id }),
  'member.joined': z.object({ userId: id }),
  'member.left': z.object({ userId: id }),
} satisfies Record<string, z.ZodTypeAny>;

export type EventType = keyof typeof eventPayloads;
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>;
export type TopicKind = 'task' | 'repo' | 'user' | 'org:admin';

const TASK_EVENTS = [
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
] as const satisfies readonly EventType[];
const REPO_EVENTS = [
  'task.created',
  'task.moved',
  'task.deleted',
  'channel.message',
  'repo_agent.memory_updated',
] as const satisfies readonly EventType[];
const USER_EVENTS = [
  'notification',
  'builder.presence',
  'builder.paired',
  'builder.revoked',
  'repo_access.changed',
  'chat.message',
  'budget.warning',
  'budget.exceeded',
] as const satisfies readonly EventType[];
const ORG_ADMIN_EVENTS = [
  'credential.status',
  'budget.warning',
  'budget.exceeded',
  'stale_branch.found',
  'installation.changed',
  'member.joined',
  'member.left',
] as const satisfies readonly EventType[];

/** Which kinds of topic each event may be sent on. */
export const EVENT_TOPIC_KINDS: Record<EventType, readonly TopicKind[]> = Object.fromEntries(
  (Object.keys(eventPayloads) as EventType[]).map((type) => [
    type,
    [
      ...((TASK_EVENTS as readonly string[]).includes(type) ? (['task'] as const) : []),
      ...((REPO_EVENTS as readonly string[]).includes(type) ? (['repo'] as const) : []),
      ...((USER_EVENTS as readonly string[]).includes(type) ? (['user'] as const) : []),
      ...((ORG_ADMIN_EVENTS as readonly string[]).includes(type) ? (['org:admin'] as const) : []),
    ],
  ]),
) as unknown as Record<EventType, readonly TopicKind[]>;

export const topicKindOf = (topic: string): TopicKind | null =>
  topic === 'org:admin'
    ? 'org:admin'
    : ((['task', 'repo', 'user'] as const).find((k) => topic.startsWith(`${k}:`)) ?? null);

/** An event as the web app receives it: the envelope with a typed payload. */
export type AppEvent = {
  [T in EventType]: Omit<EventEnvelope, 'type' | 'payload'> & { type: T; payload: EventPayload<T> };
}[EventType];
