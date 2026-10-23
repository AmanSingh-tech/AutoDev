import { and, desc, eq, inArray, isNull, schema, sql, type FindingKind, type FindingSeverity, type SystemDb } from '@autodev/db';
import { dependencyScan, driftScan, repeatedVulnerabilities, spendScan, stuckScan, testScan, type Detection, type RepoFiles } from './scans';
import type { SourceUrls } from './sources';

const { agentPolicies, groupAgentFindings, groupAgentRuns, notifications, orgMembers, orgs, recommendations, repos } = schema;

/** Points an open finding takes off its repo's health score (100 = nothing open). */
export const HEALTH_PENALTY: Record<FindingSeverity, number> = { low: 2, medium: 7, high: 15, critical: 30 };

export interface GroupAgentDeps {
  sys: SystemDb;
  urls: SourceUrls;
  /** Reads a repo at its default branch with the App's installation token. */
  filesFor: (repo: { owner: string; name: string; defaultBranch: string; githubInstallationId: number }) => Promise<RepoFiles>;
}

/** The org's Group Agent switch. Absent row = off. */
export async function isEnabled(sys: SystemDb, orgId: string) {
  const [p] = await sys.select({ enabled: agentPolicies.enabled }).from(agentPolicies).where(and(eq(agentPolicies.orgId, orgId), isNull(agentPolicies.repoId)));
  return p?.enabled ?? false;
}

/**
 * One scan of one org. Checks that fail are recorded and their findings are left as they were, so an
 * outage at OSV never "resolves" a vulnerability. `force` runs it even when the agent is off (tests).
 */
export async function runScan(deps: GroupAgentDeps, orgId: string, now = new Date(), opts: { force?: boolean } = {}) {
  const { sys } = deps;
  if (!opts.force && !(await isEnabled(sys, orgId))) return { skipped: 'disabled' as const };
  const [run] = await sys.insert(groupAgentRuns).values({ orgId, kind: 'scan', startedAt: now }).returning();
  const detections: Detection[] = [];
  /** `kind|repoId` (or `kind|*` for org-wide checks) for every check that completed. */
  const completed = new Set<string>();
  const errors: { check: string; repo?: string; message: string }[] = [];

  const repoRows = await sys
    .select({ id: repos.id, owner: repos.owner, name: repos.name, fullName: repos.fullName, defaultBranch: repos.defaultBranch, githubInstallationId: schema.installations.githubInstallationId, scan: agentPolicies.enabled, hasPolicy: agentPolicies.id })
    .from(repos)
    .innerJoin(schema.installations, eq(schema.installations.id, repos.installationId))
    .leftJoin(agentPolicies, and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.repoId, repos.id)))
    .where(and(eq(repos.orgId, orgId), isNull(repos.deletedAt), eq(repos.archived, false), isNull(schema.installations.deletedAt)));
  // A repo row turns scanning off for that repo; no row means it's scanned.
  const scanned = repoRows.filter((r) => !r.hasPolicy || r.scan);

  const perRepo: Detection[] = [];
  for (const repo of scanned) {
    try {
      const files = await deps.filesFor(repo);
      const r = await dependencyScan(deps.urls, repo, files);
      perRepo.push(...r.detections);
      completed.add(`vulnerable_dependency|${repo.id}`).add(`outdated_dependency|${repo.id}`);
    } catch (e) {
      errors.push({ check: 'dependencies', repo: repo.fullName, message: e instanceof Error ? e.message : String(e) });
    }
  }
  detections.push(...perRepo);
  if (errors.length === 0) completed.add('repeated_failure|vuln');
  detections.push(...repeatedVulnerabilities(perRepo));

  const orgChecks: [string, FindingKind[], () => Promise<Detection[]>][] = [
    ['tests', ['failing_test', 'flaky_test', 'repeated_failure'], () => testScan(sys, orgId, now)],
    ['drift', ['linked_repo_drift'], () => driftScan(sys, orgId, now)],
    ['spend', ['unusual_spend'], () => spendScan(sys, orgId, now)],
    ['stuck', ['stuck_task'], () => stuckScan(sys, orgId, now)],
  ];
  for (const [check, kinds, scan] of orgChecks) {
    try {
      detections.push(...(await scan()));
      for (const k of kinds) completed.add(k === 'repeated_failure' ? 'repeated_failure|error' : `${k}|*`);
    } catch (e) {
      errors.push({ check, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const { created, reopened } = await applyDetections(sys, orgId, run!.id, detections, now);
  const resolved = await resolveUnseen(sys, orgId, run!.id, completed, now);
  const health = await healthByRepo(sys, orgId);
  const byKind = Object.fromEntries(detections.reduce((m, d) => m.set(d.kind, (m.get(d.kind) ?? 0) + 1), new Map<string, number>()));
  await sys
    .update(groupAgentRuns)
    .set({
      status: errors.length && errors.length >= scanned.length + orgChecks.length ? 'failed' : 'succeeded',
      payload: { detections: detections.length, byKind, created, reopened, resolved, errors, health, repos: scanned.length },
      finishedAt: new Date(),
    })
    .where(eq(groupAgentRuns.id, run!.id));
  return { runId: run!.id, detections: detections.length, created, reopened, resolved, errors };
}

/** Upserts one finding per fingerprint and its recommendation. A dismissed recommendation stays dismissed. */
async function applyDetections(sys: SystemDb, orgId: string, runId: string, detections: Detection[], now: Date) {
  let created = 0;
  let reopened = 0;
  const seen = new Set<string>();
  for (const d of detections) {
    if (seen.has(d.fingerprint)) continue;
    seen.add(d.fingerprint);
    await sys.transaction(async (tx) => {
      const [f] = (await tx.execute(sql`
        INSERT INTO group_agent_findings (id, org_id, repo_id, kind, severity, fingerprint, title, details, first_seen_at, last_seen_at, last_run_id)
        VALUES (gen_random_uuid(), ${orgId}, ${d.repoId}, ${d.kind}, ${d.severity}, ${d.fingerprint}, ${d.title}, ${JSON.stringify(d.details)}::jsonb, ${now.toISOString()}, ${now.toISOString()}, ${runId})
        ON CONFLICT (org_id, fingerprint) DO UPDATE SET
          severity = EXCLUDED.severity, title = EXCLUDED.title, details = EXCLUDED.details, repo_id = EXCLUDED.repo_id,
          last_seen_at = EXCLUDED.last_seen_at, last_run_id = EXCLUDED.last_run_id, resolved_at = NULL
        RETURNING id, (xmax = 0) AS inserted,
          (SELECT resolved_at IS NOT NULL FROM group_agent_findings old WHERE old.org_id = ${orgId} AND old.fingerprint = ${d.fingerprint}) AS was_resolved`)) as unknown as { id: string; inserted: boolean; was_resolved: boolean | null }[];
      if (f!.inserted) created++;
      else if (f!.was_resolved) reopened++;
      await tx.execute(sql`
        INSERT INTO recommendations (id, org_id, finding_id, repo_id, status, title, body_md, fix_kind, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, ${f!.id}, ${d.repoId}, 'open', ${d.recommendation.title}, ${d.recommendation.bodyMd}, ${d.recommendation.fixKind}, ${now.toISOString()}, ${now.toISOString()})
        ON CONFLICT (finding_id) DO UPDATE SET
          title = EXCLUDED.title, body_md = EXCLUDED.body_md, fix_kind = EXCLUDED.fix_kind, repo_id = EXCLUDED.repo_id,
          status = CASE WHEN recommendations.status = 'resolved' THEN 'open'::recommendation_status ELSE recommendations.status END,
          updated_at = EXCLUDED.updated_at`);
    });
  }
  return { created, reopened };
}

/** Findings of completed checks that this run didn't see are resolved, with their open recommendations. */
async function resolveUnseen(sys: SystemDb, orgId: string, runId: string, completed: Set<string>, now: Date) {
  const open = await sys
    .select({ id: groupAgentFindings.id, kind: groupAgentFindings.kind, repoId: groupAgentFindings.repoId, lastRunId: groupAgentFindings.lastRunId, fingerprint: groupAgentFindings.fingerprint })
    .from(groupAgentFindings)
    .where(and(eq(groupAgentFindings.orgId, orgId), isNull(groupAgentFindings.resolvedAt)));
  const scope = (f: (typeof open)[number]) =>
    f.kind === 'repeated_failure' ? `repeated_failure|${f.fingerprint.startsWith('repeated:vuln:') ? 'vuln' : 'error'}` : f.kind === 'vulnerable_dependency' || f.kind === 'outdated_dependency' ? `${f.kind}|${f.repoId}` : `${f.kind}|*`;
  const gone = open.filter((f) => f.lastRunId !== runId && completed.has(scope(f))).map((f) => f.id);
  if (gone.length) {
    await sys.update(groupAgentFindings).set({ resolvedAt: now }).where(inArray(groupAgentFindings.id, gone));
    await sys.update(recommendations).set({ status: 'resolved', updatedAt: now }).where(and(inArray(recommendations.findingId, gone), eq(recommendations.status, 'open')));
  }
  return gone.length;
}

/** 100 minus a penalty per open finding, per repo. Findings across repos count for each repo they name. */
export async function healthByRepo(sys: SystemDb, orgId: string): Promise<Record<string, number>> {
  const all = await sys.select({ id: repos.id }).from(repos).where(and(eq(repos.orgId, orgId), isNull(repos.deletedAt)));
  const open = await sys
    .select({ repoId: groupAgentFindings.repoId, severity: groupAgentFindings.severity, details: groupAgentFindings.details })
    .from(groupAgentFindings)
    .where(and(eq(groupAgentFindings.orgId, orgId), isNull(groupAgentFindings.resolvedAt)));
  const score: Record<string, number> = Object.fromEntries(all.map((r) => [r.id, 100]));
  for (const f of open) {
    const ids = f.repoId ? [f.repoId] : ((f.details.repoIds as string[] | undefined) ?? []);
    for (const id of ids) if (id in score) score[id] = Math.max(0, score[id]! - HEALTH_PENALTY[f.severity]);
  }
  return score;
}

const RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * The weekly digest: health per repo against the last digest, the top risks, and what's new and
 * resolved since. Stored as a run and sent to admins as a notification.
 */
export async function runDigest(sys: SystemDb, orgId: string, now = new Date(), opts: { force?: boolean } = {}) {
  if (!opts.force && !(await isEnabled(sys, orgId))) return { skipped: 'disabled' as const };
  const [prev] = await sys
    .select()
    .from(groupAgentRuns)
    .where(and(eq(groupAgentRuns.orgId, orgId), eq(groupAgentRuns.kind, 'digest')))
    .orderBy(desc(groupAgentRuns.startedAt))
    .limit(1);
  const since = prev?.startedAt ?? new Date(now.getTime() - 7 * 86_400_000);
  const health = await healthByRepo(sys, orgId);
  const before = (prev?.payload.health as Record<string, number> | undefined) ?? {};
  const names = new Map((await sys.select({ id: repos.id, fullName: repos.fullName }).from(repos).where(eq(repos.orgId, orgId))).map((r) => [r.id, r.fullName]));
  const repoHealth = Object.entries(health)
    .map(([id, score]) => ({ repoId: id, name: names.get(id) ?? id, score, previous: before[id] ?? null }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

  const open = await sys
    .select({ id: groupAgentFindings.id, title: groupAgentFindings.title, severity: groupAgentFindings.severity, kind: groupAgentFindings.kind, repoId: groupAgentFindings.repoId, firstSeenAt: groupAgentFindings.firstSeenAt })
    .from(groupAgentFindings)
    .where(and(eq(groupAgentFindings.orgId, orgId), isNull(groupAgentFindings.resolvedAt)));
  const topRisks = [...open].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.firstSeenAt.getTime() - a.firstSeenAt.getTime()).slice(0, 5);
  const [{ resolved } = { resolved: 0 }] = (await sys.execute(
    sql`SELECT count(*)::int AS resolved FROM group_agent_findings WHERE org_id = ${orgId} AND resolved_at >= ${since.toISOString()}`,
  )) as unknown as { resolved: number }[];
  const newCount = open.filter((f) => f.firstSeenAt >= since).length;
  const needAttention = repoHealth.filter((r) => r.score < 70).length;

  const [run] = await sys
    .insert(groupAgentRuns)
    .values({
      orgId,
      kind: 'digest',
      status: 'succeeded',
      startedAt: now,
      finishedAt: now,
      payload: { since: since.toISOString(), health, repos: repoHealth, topRisks: topRisks.map((f) => ({ id: f.id, title: f.title, severity: f.severity, kind: f.kind, repoId: f.repoId })), newFindings: newCount, resolvedFindings: resolved, openFindings: open.length },
    })
    .returning();

  const [org] = await sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId));
  const admins = await sys
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 'active'), inArray(orgMembers.role, ['owner', 'admin'])));
  const title = needAttention ? `Weekly health: ${needAttention} ${needAttention === 1 ? 'repository needs' : 'repositories need'} attention` : 'Weekly health: all repositories look healthy';
  const body = `${open.length} open findings (${newCount} new, ${resolved} resolved this week).${topRisks[0] ? ` Top risk: ${topRisks[0].title}.` : ''}`;
  if (admins.length)
    await sys.insert(notifications).values(admins.map((a) => ({ orgId, userId: a.userId, type: 'group_agent.digest', title, body, link: `/o/${org!.slug}/group-agent/digest`, payload: { runId: run!.id } })));
  return { runId: run!.id, notified: admins.length, needAttention };
}

/** Every org with the agent on (the nightly scan and the weekly digest). */
export async function enabledOrgs(sys: SystemDb): Promise<string[]> {
  const list = await sys.select({ orgId: agentPolicies.orgId }).from(agentPolicies).where(and(isNull(agentPolicies.repoId), eq(agentPolicies.enabled, true)));
  return list.map((r) => r.orgId);
}
