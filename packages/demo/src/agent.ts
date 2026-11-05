import { createHash } from 'node:crypto';
import { and, desc, eq, FIRST_PHASE, max, schema, sql, transitionTask, type SystemDb } from '@autodev/db';
import type { BlobStore } from '@autodev/storage';
import { demoDesign, demoFiles, demoPlan, demoSummary, demoTestLog, type DemoTaskInput } from './content';

const { agentRuns, agentSteps, builderJobs, orgs, pullRequests, repos, taskDocuments, tasks, workspaceFiles, workspaces } = schema;

type Task = typeof tasks.$inferSelect;
const AGENT = { type: 'agent' as const, userId: null };

export interface DemoAgentDeps {
  sys: SystemDb;
  blobs: BlobStore;
  webUrl: string;
  /** Pause between visible steps, so people watching see the agent work. 0 in tests. */
  stepMs?: number;
}

/** Whether an org is a demo org (created by "Try the demo"). */
export async function isDemoOrg(sys: SystemDb, orgId: string): Promise<boolean> {
  const [o] = await sys.select({ demo: sql<boolean>`coalesce((${orgs.settings} ->> 'demo')::boolean, false)` }).from(orgs).where(eq(orgs.id, orgId));
  return !!o?.demo;
}

/**
 * The simulated agent for demo orgs. It moves a task through the same statuses as the real one
 * (plan → approval → design → approval → code → tests → pull request), writing believable
 * documents, steps, a diff and a test log, without a model, GitHub or a builder.
 */
export class DemoAgent {
  constructor(private readonly deps: DemoAgentDeps) {}

  private pause = (factor = 1) => new Promise((r) => setTimeout(r, (this.deps.stepMs ?? 900) * factor));

  async process(job: { orgId: string; taskId: string }): Promise<string> {
    const { sys } = this.deps;
    let [t] = await sys.select().from(tasks).where(and(eq(tasks.id, job.taskId), eq(tasks.orgId, job.orgId)));
    if (!t) return 'missing';
    if (t.status === 'queued') {
      await this.pause(0.5);
      t = (await transitionTask(sys, t, FIRST_PHASE[t.mode], AGENT, { demo: true })).task;
    }
    if (t.status === 'planning') return this.plan(t);
    if (t.status === 'designing') return this.design(t);
    if (t.status === 'coding' || t.status === 'fixing') return this.code(t);
    return `ignored:${t.status}`;
  }

  private async input(t: Task): Promise<DemoTaskInput> {
    const [r] = await this.deps.sys.select({ name: repos.name }).from(repos).where(eq(repos.id, t.repoId));
    return { key: t.key, title: t.title, descriptionMd: t.descriptionMd, repoName: r?.name ?? 'app' };
  }

  /** A run with a few visible steps, like the real agent's activity feed. */
  private async run(t: Task, phase: 'plan' | 'lld' | 'code', steps: { tool: string | null; input?: unknown; output: string }[]) {
    const { sys } = this.deps;
    const [run] = await sys.insert(agentRuns).values({ orgId: t.orgId, taskId: t.id, phase, model: 'demo-agent', status: 'running' }).returning();
    let seq = 0;
    for (const s of steps) {
      await this.pause();
      await sys.insert(agentSteps).values({
        orgId: t.orgId,
        taskId: t.id,
        agentRunId: run!.id,
        seq: seq++,
        kind: s.tool ? 'tool_call' : 'message',
        toolName: s.tool,
        input: s.input ?? null,
        output: s.output,
        durationMs: 300 + ((seq * 137) % 900),
      });
    }
    const tokens = 18_000 + steps.length * 4_200;
    await sys
      .update(agentRuns)
      .set({ status: 'succeeded', endedAt: new Date(), turns: steps.length, inputTokens: tokens, outputTokens: Math.round(tokens / 6) })
      .where(eq(agentRuns.id, run!.id));
    return run!;
  }

  private async lastFeedback(t: Task, kind: 'plan' | 'lld') {
    const [last] = await this.deps.sys
      .select({ version: taskDocuments.version, comment: taskDocuments.comment, status: taskDocuments.status })
      .from(taskDocuments)
      .where(and(eq(taskDocuments.taskId, t.id), eq(taskDocuments.kind, kind)))
      .orderBy(desc(taskDocuments.version))
      .limit(1);
    return { version: (last?.version ?? 0) + 1, feedback: last?.status === 'changes_requested' ? last.comment : null };
  }

  private async plan(t: Task) {
    const input = await this.input(t);
    const { version, feedback } = await this.lastFeedback(t, 'plan');
    const files = demoFiles(input);
    const run = await this.run(t, 'plan', [
      { tool: 'list_files', input: { path: '.' }, output: 'src/\ntests/\npackage.json\nREADME.md\n.autodev.yml' },
      { tool: 'search', input: { query: input.title.split(' ').slice(0, 3).join(' ') }, output: `Found 4 matches in ${files[files.length - 1]!.path} and 2 test files.` },
      { tool: 'read_file', input: { path: files[files.length - 1]!.path }, output: files[files.length - 1]!.before || '(new file)' },
      { tool: null, output: feedback ? `Revising the plan after review: ${feedback}` : 'Writing the plan.' },
    ]);
    await this.deps.sys.insert(taskDocuments).values({ orgId: t.orgId, taskId: t.id, kind: 'plan', version, contentMd: demoPlan(input, version, feedback), status: 'pending_review', agentRunId: run.id });
    await transitionTask(this.deps.sys, t, 'awaiting_plan_approval', AGENT, { kind: 'plan', version, demo: true });
    return 'plan';
  }

  private async design(t: Task) {
    const input = await this.input(t);
    const { version, feedback } = await this.lastFeedback(t, 'lld');
    const run = await this.run(t, 'lld', [
      { tool: 'read_file', input: { path: 'package.json' }, output: '{ "name": "' + input.repoName + '", "scripts": { "test": "vitest run" } }' },
      { tool: null, output: feedback ? `Revising the design after review: ${feedback}` : 'Writing the design for the approved plan.' },
    ]);
    await this.deps.sys.insert(taskDocuments).values({ orgId: t.orgId, taskId: t.id, kind: 'lld', version, contentMd: demoDesign(input, version, feedback), status: 'pending_review', agentRunId: run.id });
    await transitionTask(this.deps.sys, t, 'awaiting_lld_approval', AGENT, { kind: 'lld', version, demo: true });
    return 'design';
  }

  private async code(t: Task) {
    const { sys, blobs } = this.deps;
    const input = await this.input(t);
    const files = demoFiles(input);
    await this.run(
      t,
      'code',
      files.map((f) => ({ tool: f.op === 'create' ? 'write_file' : 'edit_file', input: { path: f.path }, output: `${f.op === 'create' ? 'Created' : 'Updated'} ${f.path} (${f.after.split('\n').length} lines)` })),
    );
    await writeWorkspace(sys, t, files);
    let current = (await transitionTask(sys, t, 'testing', AGENT, { demo: true })).task;

    // The test run, as a builder job: running for a moment, then passed with its log.
    const { log, durationMs } = demoTestLog(input, files);
    const patch = files.map((f) => `--- ${f.path}\n+++ ${f.path}\n${f.after}`).join('\n');
    const sha = createHash('sha256').update(patch).digest('hex');
    const [job] = await sys
      .insert(builderJobs)
      .values({ orgId: t.orgId, taskId: t.id, repoId: t.repoId, requestedBy: t.ownerId, baseSha: 'd'.repeat(40), workspaceRevision: files.length, patchHash: sha, patchSha256: sha, final: true, status: 'running', startedAt: new Date() })
      .returning();
    await this.pause(3);
    const logHash = await blobs.put(log);
    await sys.update(builderJobs).set({ status: 'passed', exitCode: 0, durationMs, logHash, logTail: log.split('\n').slice(-6).join('\n'), finishedAt: new Date() }).where(eq(builderJobs.id, job!.id));

    current = (await transitionTask(sys, current, 'pushed', AGENT, { demo: true, jobId: job!.id })).task;
    await sys.update(tasks).set({ summaryMd: demoSummary(input, files) }).where(eq(tasks.id, t.id));
    if (!t.createPrOnCompletion) return 'pushed';
    await openDemoPr(sys, current, this.deps.webUrl, { createdBy: t.byGroupAgent ? 'group_agent' : 'agent_on_completion' });
    return 'pr_open';
  }
}

/** The agent's change as the workspace overlay the diff view reads. */
export async function writeWorkspace(sys: SystemDb, t: { id: string; orgId: string; repoId: string }, files: { path: string; op: 'create' | 'modify'; after: string }[]) {
  const [ws] = await sys
    .insert(workspaces)
    .values({ orgId: t.orgId, taskId: t.id, repoId: t.repoId, baseSha: 'd'.repeat(40), baseRef: 'main', revision: files.length })
    .onConflictDoUpdate({ target: workspaces.taskId, set: { revision: files.length, updatedAt: new Date() } })
    .returning();
  await sys.delete(workspaceFiles).where(eq(workspaceFiles.workspaceId, ws!.id));
  await sys.insert(workspaceFiles).values(files.map((f) => ({ workspaceId: ws!.id, orgId: t.orgId, path: f.path, op: f.op, content: f.after })));
}

/** A pull request row (demo orgs have no GitHub; the link opens the task). */
export async function openDemoPr(sys: SystemDb, t: Task, webUrl: string, opts: { createdBy?: 'agent_on_completion' | 'group_agent'; mergedAt?: Date | null } = {}) {
  const [{ n } = { n: null }] = await sys.select({ n: max(pullRequests.number) }).from(pullRequests).where(eq(pullRequests.repoId, t.repoId));
  const number = (n ?? 100) + 1;
  const [org] = await sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, t.orgId));
  await sys.insert(pullRequests).values({
    orgId: t.orgId,
    taskId: t.id,
    repoId: t.repoId,
    githubPrId: -Math.floor(Math.random() * 1e12),
    number,
    url: `${webUrl}/o/${org!.slug}/tasks/${t.key}`,
    headBranch: t.workBranch,
    baseBranch: 'main',
    state: opts.mergedAt ? 'merged' : 'open',
    mergedAt: opts.mergedAt ?? null,
    createdBy: opts.createdBy ?? 'agent_on_completion',
  });
  return (await transitionTask(sys, t, 'pr_open', AGENT, { demo: true, number })).task;
}
