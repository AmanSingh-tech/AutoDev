import { and, desc, eq, isNull, schema, transitionTask, type SystemDb, type TaskStatus } from '@autodev/db';

const { agentRuns, auditLog, builderJobs, taskDocuments, taskQuestions, tasks } = schema;

const AUTOPILOT = { type: 'agent' as const, userId: null };

/** What Autopilot says when the agent asks something and nobody is there. */
export const ASSUME_ANSWER =
  'Autopilot is on and nobody is available to answer. Use your best judgement: choose the safest reasonable option that meets the acceptance criteria, carry on, and list this decision under "Assumptions" in your summary so the reviewer sees it in the morning.';
export const DEVIATION_DENIED =
  'Not allowed while on Autopilot: stay within the approved files. If the task can’t be finished without them, do what you can inside them and explain what’s missing under "Assumptions" in your summary.';
export const CONFIG_DENIED =
  'The test run was not allowed: on Autopilot, changes to .autodev.yml are never run. Revert your changes to .autodev.yml (it is not part of this task) and finish again.';

export interface AdvanceDeps {
  sys: SystemDb;
  /** Queue the agent for the task again (the event id makes the job id unique). */
  enqueue: (orgId: string, taskId: string, eventId: string) => Promise<unknown>;
}

async function resumeStatus(sys: SystemDb, taskId: string): Promise<TaskStatus | null> {
  const [run] = await sys
    .select({ resumeStatus: agentRuns.resumeStatus })
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.status, 'paused')))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);
  return run?.resumeStatus ?? null;
}

/**
 * Plays the person's part for an Autopilot task, after each agent run: approves a plan or design
 * waiting for review, answers a question (assume and note it), refuses a deviation, and refuses a
 * test run with a changed .autodev.yml. Everything it decides is recorded like a person's decision
 * would be, so the morning review shows it. Returns what it did, or null.
 */
export async function advanceAutopilotTask(deps: AdvanceDeps, taskId: string): Promise<string | null> {
  const { sys } = deps;
  const [t] = await sys.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || !t.autopilot) return null;

  const record = (action: string, metadata: Record<string, unknown>) =>
    sys.insert(auditLog).values({ orgId: t.orgId, actorType: 'agent', action, targetType: 'task', targetId: t.id, metadata: { task: t.key, ...metadata } });

  if (t.status === 'awaiting_plan_approval' || t.status === 'awaiting_lld_approval') {
    const kind = t.status === 'awaiting_plan_approval' ? 'plan' : 'lld';
    const [doc] = await sys
      .update(taskDocuments)
      .set({ status: 'approved', reviewerId: null, comment: 'Approved by Autopilot', reviewedAt: new Date() })
      .where(and(eq(taskDocuments.taskId, t.id), eq(taskDocuments.kind, kind), eq(taskDocuments.status, 'pending_review')))
      .returning();
    if (!doc) return null;
    const to: TaskStatus = kind === 'plan' && t.mode === 'plan_lld' ? 'designing' : 'coding';
    const { eventId } = await transitionTask(sys, t, to, AUTOPILOT, { kind, version: doc.version, decision: 'approve', autopilot: true });
    await record(`doc.approved`, { kind, version: doc.version, autopilot: true });
    await deps.enqueue(t.orgId, t.id, eventId);
    return `approved_${kind}`;
  }

  if (t.status === 'needs_input') {
    const [q] = await sys.select().from(taskQuestions).where(and(eq(taskQuestions.taskId, t.id), isNull(taskQuestions.answeredAt)));
    if (!q) return null;
    const deviation = q.kind === 'deviation';
    await sys
      .update(taskQuestions)
      .set({ answerMd: deviation ? DEVIATION_DENIED : ASSUME_ANSWER, answeredBy: null, answeredAt: new Date(), approved: deviation ? false : null })
      .where(eq(taskQuestions.id, q.id));
    const to = (await resumeStatus(sys, t.id)) ?? 'coding';
    const { eventId } = await transitionTask(sys, t, to, AUTOPILOT, { questionId: q.id, autopilot: true });
    await record(deviation ? 'deviation.denied' : 'question.assumed', { questionId: q.id, autopilot: true });
    await deps.enqueue(t.orgId, t.id, eventId);
    return deviation ? 'denied_deviation' : 'assumed';
  }

  // A test run that would execute a changed .autodev.yml waits for consent; Autopilot never gives it.
  const [pending] = await sys.select().from(builderJobs).where(and(eq(builderJobs.taskId, t.id), eq(builderJobs.consent, 'pending')));
  if (pending) {
    await sys
      .update(builderJobs)
      .set({ consent: 'denied', status: 'failed', failedStep: 'system', finishedAt: new Date(), logTail: CONFIG_DENIED })
      .where(eq(builderJobs.id, pending.id));
    await record('builder_job.consent_denied', { jobId: pending.id, autopilot: true });
    if (t.status === 'testing' || t.status === 'waiting_for_builder') {
      const { eventId } = await transitionTask(sys, { ...t, status: t.status }, 'testing', AUTOPILOT, { jobId: pending.id, consent: 'denied', autopilot: true }).catch(async () => ({ eventId: `consent-${pending.id}` }));
      await deps.enqueue(t.orgId, t.id, eventId);
    }
    return 'denied_config';
  }
  return null;
}
