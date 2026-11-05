import { createHash } from 'node:crypto';
import { and, eq, schema, transitionTask, type SystemDb } from '@autodev/db';
import type { BlobStore } from '@autodev/storage';
import { demoDesign, demoFiles, demoPlan } from './content';

const { agentPolicies, agentRuns, builderJobs, channelMessages, groupAgentFindings, groupAgentRuns, recommendations, repoChannels, taskDocuments, taskEvents, taskQuestions, tasks } = schema;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The parts of a demo org that make it feel lived-in: the agent waiting on a question, a test run
 * that failed before the fix, Group Agent findings and a digest, and a team-room conversation.
 */
export async function enrichDemoOrg(
  deps: { sys: SystemDb; blobs: BlobStore },
  org: { id: string; repos: { id: string; name: string; fullName: string }[]; you: string; people: Map<string, string>; nextNumber: number },
): Promise<number> {
  const { sys } = deps;
  const repo = (name: string) => org.repos.find((r) => r.name === name)!;
  let n = org.nextNumber;

  // 1. The agent asks a question mid-coding and waits for an answer.
  {
    n++;
    const r = repo('web');
    const key = `ACME-${n}`;
    const input = { key, title: 'Export the usage report as CSV', descriptionMd: 'Add a "Download CSV" button to the usage report.', repoName: r.name };
    const [t] = await sys
      .insert(tasks)
      .values({ orgId: org.id, repoId: r.id, number: n, key, title: input.title, descriptionMd: input.descriptionMd, acceptanceCriteriaMd: '- The CSV matches the table\n- Covered by tests', priority: 'medium', mode: 'plan_lld', branchMode: 'new', workBranch: `autodev/${key.toLowerCase()}`, ownerId: org.you, createdBy: org.you, createPrOnCompletion: true })
      .returning();
    await sys.insert(taskEvents).values({ orgId: org.id, taskId: t!.id, actorType: 'user', actorUserId: org.you, type: 'created' });
    let cur = t!;
    for (const to of ['queued', 'planning', 'awaiting_plan_approval', 'designing', 'awaiting_lld_approval', 'coding'] as const) {
      cur = (await transitionTask(sys, cur, to, to.startsWith('awaiting') || to === 'planning' || to === 'designing' || to === 'coding' ? { type: 'agent', userId: null } : { type: 'user', userId: org.you }, { demo: true })).task;
      if (to === 'awaiting_plan_approval') await sys.insert(taskDocuments).values({ orgId: org.id, taskId: t!.id, kind: 'plan', version: 1, contentMd: demoPlan(input, 1), status: 'approved', reviewerId: org.you, reviewedAt: new Date() });
      if (to === 'awaiting_lld_approval') await sys.insert(taskDocuments).values({ orgId: org.id, taskId: t!.id, kind: 'lld', version: 1, contentMd: demoDesign(input, 1), status: 'approved', reviewerId: org.you, reviewedAt: new Date() });
    }
    const [run] = await sys.insert(agentRuns).values({ orgId: org.id, taskId: t!.id, phase: 'code', model: 'demo-agent', status: 'paused', resumeStatus: 'coding', turns: 4 }).returning();
    await sys.insert(taskQuestions).values({
      orgId: org.id,
      taskId: t!.id,
      agentRunId: run!.id,
      kind: 'question',
      questionMd: 'The usage table can be filtered by month and by person. Should the CSV contain **only the rows currently shown**, or **the whole month** regardless of the filter?',
    });
    await transitionTask(sys, cur, 'needs_input', { type: 'agent', userId: null }, { demo: true });
  }

  // 2. A merged task whose first test run failed, then passed after the fix.
  {
    const [t] = await sys.select().from(tasks).where(and(eq(tasks.orgId, org.id), eq(tasks.title, 'Retry failed push notifications with backoff')));
    const [passed] = t ? await sys.select().from(builderJobs).where(eq(builderJobs.taskId, t.id)) : [];
    if (t && passed) {
      const repoName = org.repos.find((r) => r.id === t.repoId)?.name ?? 'app';
      const testFile = demoFiles({ key: t.key, title: t.title, descriptionMd: t.descriptionMd, repoName }).find((f) => /\.test\./.test(f.path))!.path;
      const log = [
        '> mobile@1.0.0 test',
        '> vitest run',
        '',
        ` ✓ ${testFile} (1 test) 141ms`,
        ` ✗ ${testFile} > says so when there is nothing to show`,
        '   TestingLibraryElementError: Unable to find an element with the text: Nothing here yet.',
        '',
        ' Test Files  1 failed | 2 passed (3)',
        '      Tests  1 failed | 15 passed (16)',
        '',
      ].join('\n');
      const at = new Date((passed.queuedAt ?? new Date()).getTime() - 40 * 60_000);
      await sys.insert(builderJobs).values({
        orgId: org.id,
        taskId: t.id,
        repoId: t.repoId,
        requestedBy: t.ownerId,
        baseSha: passed.baseSha,
        workspaceRevision: Math.max(0, passed.workspaceRevision - 1),
        patchHash: createHash('sha256').update(`${t.id}:first`).digest('hex'),
        patchSha256: createHash('sha256').update(`${t.id}:first`).digest('hex'),
        status: 'failed',
        exitCode: 1,
        failedStep: 'test',
        failedTests: [{ name: 'says so when there is nothing to show', file: testFile, message: 'Unable to find an element with the text: Nothing here yet.' }],
        durationMs: 16_900,
        logHash: await deps.blobs.put(log),
        logTail: log.split('\n').slice(-5).join('\n'),
        queuedAt: at,
        startedAt: at,
        finishedAt: new Date(at.getTime() + 17_000),
      });
      await sys.insert(agentRuns).values({ orgId: org.id, taskId: t.id, phase: 'fix', model: 'demo-agent', status: 'succeeded', fixCycle: 1, turns: 3, inputTokens: 21_400, outputTokens: 2_900, startedAt: new Date(at.getTime() + 60_000), endedAt: new Date(at.getTime() + 4 * 60_000) });
    }
  }

  // 3. The Group Agent: on for every repo, with findings, recommendations and a weekly digest.
  {
    await sys.insert(agentPolicies).values([
      { orgId: org.id, enabled: true, weeklyPrCap: 5, monthlyBudgetUsd: '50.00' },
      ...org.repos.map((r) => ({ orgId: org.id, repoId: r.id, enabled: true, safetyLevel: 2, maintainerUserId: org.you })),
    ]);
    const [scan] = await sys.insert(groupAgentRuns).values({ orgId: org.id, kind: 'scan', status: 'succeeded', payload: { repos: org.repos.length, findings: 4 }, startedAt: new Date(Date.now() - 6 * HOUR), finishedAt: new Date(Date.now() - 6 * HOUR + 90_000) }).returning();
    const lodashTask = (await sys.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, org.id), eq(tasks.title, 'Upgrade lodash to 4.17.21'))))[0];
    const findings = [
      { repo: 'web', kind: 'vulnerable_dependency' as const, severity: 'high' as const, title: 'lodash 4.17.20 has a prototype pollution advisory', details: { ecosystem: 'npm', package: 'lodash', version: '4.17.20', fixedVersion: '4.17.21', advisory: 'CVE-2021-23337', file: 'package-lock.json' }, rec: { title: 'Upgrade lodash to 4.17.21 in acme/web', fixKind: 'dependency_bump', status: 'pr_opened' as const, taskId: lodashTask?.id ?? null } },
      { repo: 'api', kind: 'outdated_dependency' as const, severity: 'medium' as const, title: 'fastify is two majors behind (3.29 → 5.2)', details: { ecosystem: 'npm', package: 'fastify', version: '3.29.5', latest: '5.2.1', file: 'package-lock.json' }, rec: { title: 'Plan the fastify 5 upgrade for acme/api', fixKind: 'task', status: 'open' as const, taskId: null } },
      { repo: 'mobile', kind: 'flaky_test' as const, severity: 'medium' as const, title: 'push.test.ts failed 3 of the last 20 runs', details: { test: 'src/services/push.test.ts', failures: 3, runs: 20 }, rec: { title: 'Investigate the flaky push notification test', fixKind: 'investigate', status: 'open' as const, taskId: null } },
      { repo: 'api', kind: 'stuck_task' as const, severity: 'low' as const, title: 'ACME-2 has waited for design review for a day', details: { task: 'ACME-2' }, rec: null },
    ];
    for (const f of findings) {
      const r = repo(f.repo);
      const [row] = await sys
        .insert(groupAgentFindings)
        .values({ orgId: org.id, repoId: r.id, kind: f.kind, severity: f.severity, fingerprint: `demo:${f.kind}:${f.repo}:${f.title}`, title: f.title, details: f.details, firstSeenAt: new Date(Date.now() - 3 * DAY), lastRunId: scan!.id })
        .returning();
      if (f.rec)
        await sys.insert(recommendations).values({ orgId: org.id, findingId: row!.id, repoId: r.id, title: f.rec.title, bodyMd: `${f.title}. Found by the nightly scan of \`${r.fullName}\`.`, fixKind: f.rec.fixKind, status: f.rec.status, taskId: f.rec.taskId });
    }
    const open = await sys.select({ id: groupAgentFindings.id, title: groupAgentFindings.title, severity: groupAgentFindings.severity, kind: groupAgentFindings.kind, repoId: groupAgentFindings.repoId }).from(groupAgentFindings).where(eq(groupAgentFindings.orgId, org.id));
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    await sys.insert(groupAgentRuns).values({
      orgId: org.id,
      kind: 'digest',
      status: 'succeeded',
      startedAt: new Date(Date.now() - 2 * DAY),
      finishedAt: new Date(Date.now() - 2 * DAY + 30_000),
      payload: {
        since: new Date(Date.now() - 9 * DAY).toISOString(),
        repos: org.repos.map((r, i) => ({ repoId: r.id, name: r.fullName, score: [85, 78, 93][i] ?? 90, previous: [80, 82, 93][i] ?? 90 })),
        topRisks: open.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 3),
        newFindings: 3,
        resolvedFindings: 2,
        openFindings: open.length,
      },
    });
  }

  // 4. The api repo's team room: a teammate asks, the Repo Agent answers, someone follows up.
  {
    const r = repo('api');
    const [channel] = await sys.insert(repoChannels).values({ orgId: org.id, repoId: r.id }).returning();
    const priya = org.people.get('priya') ?? org.you;
    const diego = org.people.get('diego') ?? org.you;
    const at = (h: number) => new Date(Date.now() - h * HOUR);
    const [q] = await sys
      .insert(channelMessages)
      .values({ orgId: org.id, channelId: channel!.id, repoId: r.id, author: 'user', userId: priya, content: '@agent where do we map errors to HTTP status codes? I want 404s for missing orgs.', createdAt: at(26) })
      .returning();
    await sys.insert(channelMessages).values([
      {
        orgId: org.id,
        channelId: channel!.id,
        repoId: r.id,
        author: 'agent' as const,
        // Agent replies are recorded under the person who asked.
        userId: priya,
        replyToId: q!.id,
        content: 'In `src/server.ts`: each route calls a service that returns `{ ok: false, error }`, and the route turns that into a status code. A missing org is never checked there today, which is why it surfaces as a 500. There is a task for it: ACME-1.',
        createdAt: at(25.9),
        completedAt: at(25.9),
      },
      { orgId: org.id, channelId: channel!.id, repoId: r.id, author: 'user' as const, userId: diego, content: 'Nice. I’ll review the plan for ACME-1 when it’s ready.', createdAt: at(25) },
    ]);
  }

  return n;
}
