import { sql, type FindingKind, type FindingSeverity, type SystemDb } from '@autodev/db';
import { bumpKind, lockfilePaths, parseLockfile, type Dependency } from './lockfiles';
import { advisoriesFor, latestVersion, type SourceUrls } from './sources';

/**
 * The Group Agent's checks (B-5). Each returns detections; run.ts turns them into findings (one per
 * fingerprint, so a problem is reported once) and recommendations. No model is called here.
 */
export interface Detection {
  kind: FindingKind;
  severity: FindingSeverity;
  /** Stable across runs for the same problem. */
  fingerprint: string;
  repoId: string | null;
  title: string;
  details: Record<string, unknown>;
  recommendation: { title: string; bodyMd: string; fixKind: 'dependency_bump' | 'lint_fix' | 'task' | 'investigate' };
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const maxSeverity = (list: FindingSeverity[]): FindingSeverity => list.reduce((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), 'low');

/** Outdated direct dependencies reported per repo, patch bumps first. */
export const MAX_OUTDATED_PER_REPO = 20;
/** Registry look-ups per repo for "outdated", to stay polite to public registries. */
export const MAX_LATEST_LOOKUPS = 150;

export interface RepoFiles {
  paths: string[];
  read(path: string): Promise<string>;
}

/** Vulnerable and outdated dependencies of one repo, from its lockfiles at the default branch. */
export async function dependencyScan(urls: SourceUrls, repo: { id: string; fullName: string }, files: RepoFiles): Promise<{ detections: Detection[]; dependencies: number; lockfiles: string[] }> {
  const lockfiles = lockfilePaths(files.paths);
  const deps: Dependency[] = [];
  for (const path of lockfiles) deps.push(...parseLockfile(path, await files.read(path)));
  const detections: Detection[] = [];

  const advisories = await advisoriesFor(urls, deps);
  for (const [i, list] of advisories) {
    const d = deps[i]!;
    for (const a of list) {
      const bump = a.fixedVersion ? bumpKind(d.version, a.fixedVersion) : null;
      detections.push({
        kind: 'vulnerable_dependency',
        severity: a.severity,
        fingerprint: `vuln:${repo.id}:${d.ecosystem}:${d.name}:${a.id}`,
        repoId: repo.id,
        title: `${d.name} ${d.version} has ${a.id}`,
        details: { ecosystem: d.ecosystem, package: d.name, version: d.version, file: d.file, direct: d.direct, advisory: a.id, summary: a.summary, url: a.url, fixedVersion: a.fixedVersion, bump },
        recommendation: {
          title: a.fixedVersion ? `Upgrade ${d.name} to ${a.fixedVersion} in ${repo.fullName}` : `Replace or patch ${d.name} in ${repo.fullName}`,
          bodyMd: [
            `\`${d.name}@${d.version}\` (${d.ecosystem}, \`${d.file}\`${d.direct ? '' : ', pulled in by another package'}) is affected by [${a.id}](${a.url}): ${a.summary}`,
            a.fixedVersion ? `Fixed in **${a.fixedVersion}**${bump ? ` (a ${bump} upgrade)` : ''}.` : 'No fixed version is published yet.',
          ].join('\n\n'),
          fixKind: a.fixedVersion && bump === 'patch' && d.direct ? 'dependency_bump' : 'task',
        },
      });
    }
  }

  const direct = deps.filter((d) => d.direct).slice(0, MAX_LATEST_LOOKUPS);
  const outdated: Detection[] = [];
  for (const d of direct) {
    const latest = await latestVersion(urls, d.ecosystem, d.name).catch(() => null);
    const bump = latest ? bumpKind(d.version, latest) : null;
    if (!latest || (bump !== 'patch' && bump !== 'minor')) continue;
    outdated.push({
      kind: 'outdated_dependency',
      severity: 'low',
      fingerprint: `outdated:${repo.id}:${d.ecosystem}:${d.name}`,
      repoId: repo.id,
      title: `${d.name} ${d.version} → ${latest}`,
      details: { ecosystem: d.ecosystem, package: d.name, version: d.version, latest, bump, file: d.file },
      recommendation: {
        title: `Bump ${d.name} from ${d.version} to ${latest} in ${repo.fullName}`,
        bodyMd: `A ${bump} release of \`${d.name}\` is available (${d.version} → ${latest}, in \`${d.file}\`). ${bump === 'patch' ? 'Patch releases should only contain fixes.' : 'Check the changelog for new behavior.'}`,
        fixKind: bump === 'patch' ? 'dependency_bump' : 'task',
      },
    });
  }
  outdated.sort((a, b) => Number(b.details.bump === 'patch') - Number(a.details.bump === 'patch'));
  detections.push(...outdated.slice(0, MAX_OUTDATED_PER_REPO));
  return { detections, dependencies: deps.length, lockfiles };
}

/** The same vulnerable package and advisory in two or more repos: one finding for the org. */
export function repeatedVulnerabilities(perRepo: Detection[]): Detection[] {
  const groups = new Map<string, Detection[]>();
  for (const d of perRepo.filter((x) => x.kind === 'vulnerable_dependency')) {
    const key = `${d.details.ecosystem}:${d.details.package}:${d.details.advisory}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.entries()]
    .filter(([, list]) => new Set(list.map((d) => d.repoId)).size >= 2)
    .map(([key, list]) => {
      const repoIds = [...new Set(list.map((d) => d.repoId!))];
      const first = list[0]!;
      return {
        kind: 'repeated_failure' as const,
        severity: maxSeverity(list.map((d) => d.severity)),
        fingerprint: `repeated:vuln:${key}`,
        repoId: null,
        title: `${first.details.package} with ${first.details.advisory} in ${repoIds.length} repositories`,
        details: { pattern: 'vulnerable_dependency', package: first.details.package, advisory: first.details.advisory, repoIds },
        recommendation: {
          title: `Fix ${first.details.advisory} everywhere`,
          bodyMd: `The same vulnerable package, \`${first.details.package}\`, is used in ${repoIds.length} repositories. Fixing it in one place (a shared version policy or a coordinated upgrade) avoids repeating the work.`,
          fixKind: 'investigate' as const,
        },
      };
    });
}

type Rows<T> = Promise<T[]>;
const rows = <T>(sys: SystemDb, q: ReturnType<typeof sql>) => sys.execute(q) as unknown as Rows<T>;

/** Normalised error text, so the same failure reads the same in different repos and runs. */
export function errorSignature(message: string): string {
  return message
    .toLowerCase()
    .replace(/(['"`]).*?\1/g, '…')
    .replace(/(\/|\b[a-z]:\\)[^\s:]+/g, '…')
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b/g, '…')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Failing and flaky tests per repo, and failure signatures repeated across repos, from builder runs. */
export async function testScan(sys: SystemDb, orgId: string, now: Date): Promise<Detection[]> {
  const since14 = new Date(now.getTime() - 14 * 86_400_000);
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const jobs = await rows<{ id: string; repo_id: string; full_name: string; status: string; base_sha: string; patch_hash: string; finished_at: Date; failed_tests: { name: string; file?: string; message?: string }[] }>(
    sys,
    sql`SELECT j.id, j.repo_id, r.full_name, j.status, j.base_sha, j.patch_hash, j.finished_at, j.failed_tests
          FROM builder_jobs j JOIN repos r ON r.id = j.repo_id
         WHERE j.org_id = ${orgId} AND j.finished_at >= ${since30.toISOString()} AND j.status IN ('passed', 'failed')
         ORDER BY j.finished_at`,
  );
  const out: Detection[] = [];
  const testKey = (t: { name: string; file?: string }) => `${t.file ?? ''}::${t.name}`;

  // Failing: the same test failing in 3+ runs in the last 14 days.
  const failing = new Map<string, { repoId: string; repo: string; test: { name: string; file?: string }; runs: number; message?: string }>();
  // Raw SQL returns timestamps as strings.
  for (const j of jobs.filter((x) => x.status === 'failed' && new Date(x.finished_at) >= since14)) {
    for (const t of j.failed_tests ?? []) {
      const k = `${j.repo_id}|${testKey(t)}`;
      const e = failing.get(k) ?? { repoId: j.repo_id, repo: j.full_name, test: t, runs: 0, message: t.message };
      e.runs++;
      failing.set(k, e);
    }
  }
  for (const [k, e] of failing) {
    if (e.runs < 3) continue;
    out.push({
      kind: 'failing_test',
      severity: e.runs >= 6 ? 'high' : 'medium',
      fingerprint: `failing:${k}`,
      repoId: e.repoId,
      title: `${e.test.name} failed in ${e.runs} runs`,
      details: { test: e.test.name, file: e.test.file ?? null, runs: e.runs, message: e.message ?? null },
      recommendation: { title: `Fix the failing test ${e.test.name} in ${e.repo}`, bodyMd: `\`${e.test.name}\`${e.test.file ? ` (\`${e.test.file}\`)` : ''} failed in ${e.runs} builder runs in the last 14 days.${e.message ? `\n\nLast message: \`${e.message.slice(0, 300)}\`` : ''}`, fixKind: 'task' },
    });
  }

  // Flaky: failed, then passed on the same commit and the same patch, so nothing changed in between.
  const byState = new Map<string, typeof jobs>();
  for (const j of jobs) byState.set(`${j.repo_id}|${j.base_sha}|${j.patch_hash}`, [...(byState.get(`${j.repo_id}|${j.base_sha}|${j.patch_hash}`) ?? []), j]);
  const flaky = new Map<string, { repoId: string; repo: string; test: string; times: number }>();
  for (const list of byState.values()) {
    for (const [i, j] of list.entries()) {
      if (j.status !== 'failed' || !list.slice(i + 1).some((later) => later.status === 'passed')) continue;
      for (const t of j.failed_tests ?? []) {
        const k = `${j.repo_id}|${testKey(t)}`;
        const e = flaky.get(k) ?? { repoId: j.repo_id, repo: j.full_name, test: t.name, times: 0 };
        e.times++;
        flaky.set(k, e);
      }
    }
  }
  for (const [k, e] of flaky)
    out.push({
      kind: 'flaky_test',
      severity: e.times >= 3 ? 'medium' : 'low',
      fingerprint: `flaky:${k}`,
      repoId: e.repoId,
      title: `${e.test} is flaky`,
      details: { test: e.test, times: e.times },
      recommendation: { title: `Stabilise the flaky test ${e.test} in ${e.repo}`, bodyMd: `\`${e.test}\` failed and then passed on the same commit and patch ${e.times === 1 ? 'once' : `${e.times} times`} in the last 30 days, so its result doesn't depend on the code.`, fixKind: 'task' },
    });

  // The same error signature failing in 2+ repos in the last 30 days.
  const signatures = new Map<string, { sample: string; repos: Set<string> }>();
  for (const j of jobs.filter((x) => x.status === 'failed')) {
    for (const t of j.failed_tests ?? []) {
      if (!t.message) continue;
      const sig = errorSignature(t.message);
      if (sig.length < 12) continue;
      const e = signatures.get(sig) ?? { sample: t.message, repos: new Set<string>() };
      e.repos.add(j.repo_id);
      signatures.set(sig, e);
    }
  }
  for (const [sig, e] of signatures) {
    if (e.repos.size < 2) continue;
    out.push({
      kind: 'repeated_failure',
      severity: 'medium',
      fingerprint: `repeated:error:${sig}`,
      repoId: null,
      title: `The same failure in ${e.repos.size} repositories`,
      details: { pattern: 'error', signature: sig, sample: e.sample.slice(0, 300), repoIds: [...e.repos] },
      recommendation: { title: 'Look into a failure shared by several repositories', bodyMd: `Tests in ${e.repos.size} repositories fail with the same error:\n\n\`${e.sample.slice(0, 300)}\`\n\nA shared dependency, service or configuration is the likely cause.`, fixKind: 'investigate' },
    });
  }
  return out;
}

/** Work merged in a linked source repo in the last 30 days that hasn't been ported to its target (B-3). */
export async function driftScan(sys: SystemDb, orgId: string, now: Date): Promise<Detection[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const found = await rows<{ link_id: string; task_id: string; key: string; title: string; source: string; target: string; target_id: string; merged_at: Date }>(
    sys,
    sql`WITH dirs AS (
          SELECT id AS link_id, source_repo_id AS src, target_repo_id AS dst FROM repo_links WHERE org_id = ${orgId}
          UNION ALL
          SELECT id, target_repo_id, source_repo_id FROM repo_links WHERE org_id = ${orgId} AND two_way)
        SELECT d.link_id, t.id AS task_id, t.key, t.title, rs.full_name AS source, rt.full_name AS target, rt.id AS target_id, max(p.merged_at) AS merged_at
          FROM dirs d
          JOIN tasks t ON t.repo_id = d.src AND t.org_id = ${orgId}
          JOIN pull_requests p ON p.task_id = t.id AND p.merged_at >= ${since.toISOString()}
          JOIN repos rs ON rs.id = d.src
          JOIN repos rt ON rt.id = d.dst
         WHERE t.source_task_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM tasks port WHERE port.source_task_id = t.id AND port.repo_id = d.dst)
         GROUP BY d.link_id, t.id, t.key, t.title, rs.full_name, rt.full_name, rt.id`,
  );
  return found.map((f) => ({
    kind: 'linked_repo_drift' as const,
    severity: 'low' as const,
    fingerprint: `drift:${f.link_id}:${f.task_id}:${f.target_id}`,
    repoId: f.target_id,
    title: `${f.key} merged in ${f.source}, not ported to ${f.target}`,
    details: { taskKey: f.key, taskTitle: f.title, source: f.source, target: f.target, mergedAt: f.merged_at },
    recommendation: { title: `Port ${f.key} to ${f.target}`, bodyMd: `${f.key} ("${f.title}") was merged in \`${f.source}\`, which is linked to \`${f.target}\`, but nothing has been ported yet. Open ${f.key} and use **Apply to ${f.target}**, or dismiss this if the change doesn't apply there.`, fixKind: 'task' },
  }));
}

/** A person's or repo's spend yesterday (UTC) above 3× its median day over the 14 days before, and over $5. */
export const SPEND_FLOOR_USD = 5;
export async function spendScan(sys: SystemDb, orgId: string, now: Date): Promise<Detection[]> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86_400_000);
  const from = new Date(yesterday.getTime() - 14 * 86_400_000);
  const days = await rows<{ who: string; id: string; label: string; day: string; cost: number }>(
    sys,
    sql`SELECT 'user' AS who, u.user_id AS id, coalesce(us.github_login, '?') AS label, (u.created_at AT TIME ZONE 'UTC')::date::text AS day, sum(u.cost_usd)::float8 AS cost
          FROM token_usage u LEFT JOIN users us ON us.id = u.user_id
         WHERE u.org_id = ${orgId} AND u.user_id IS NOT NULL AND u.created_at >= ${from.toISOString()} AND u.created_at < ${today.toISOString()}
         GROUP BY 1, 2, 3, 4
        UNION ALL
        SELECT 'repo', u.repo_id, coalesce(r.full_name, '?'), (u.created_at AT TIME ZONE 'UTC')::date::text, sum(u.cost_usd)::float8
          FROM token_usage u LEFT JOIN repos r ON r.id = u.repo_id
         WHERE u.org_id = ${orgId} AND u.repo_id IS NOT NULL AND u.created_at >= ${from.toISOString()} AND u.created_at < ${today.toISOString()}
         GROUP BY 1, 2, 3, 4`,
  );
  const y = yesterday.toISOString().slice(0, 10);
  const groups = new Map<string, { who: string; id: string; label: string; byDay: Map<string, number> }>();
  for (const d of days) {
    const k = `${d.who}:${d.id}`;
    const g = groups.get(k) ?? { who: d.who, id: d.id, label: d.label, byDay: new Map() };
    g.byDay.set(d.day, Number(d.cost));
    groups.set(k, g);
  }
  const out: Detection[] = [];
  for (const g of groups.values()) {
    const spent = g.byDay.get(y) ?? 0;
    // Days with no usage count as $0, so a quiet person isn't compared only with their busy days.
    const history = Array.from({ length: 14 }, (_, i) => g.byDay.get(new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10)) ?? 0).sort((a, b) => a - b);
    const median = (history[6]! + history[7]!) / 2;
    if (spent <= SPEND_FLOOR_USD || spent <= 3 * median) continue;
    const ratio = median > 0 ? spent / median : null;
    out.push({
      kind: 'unusual_spend',
      severity: ratio === null || ratio >= 10 ? 'high' : 'medium',
      fingerprint: `spend:${g.who}:${g.id}:${y}`,
      repoId: g.who === 'repo' ? g.id : null,
      title: `${g.label} spent $${spent.toFixed(2)} on ${y}${ratio ? ` (${ratio.toFixed(1)}× the usual)` : ''}`,
      details: { who: g.who, id: g.id, label: g.label, day: y, spentUsd: spent, medianUsd: median },
      recommendation: { title: `Check ${g.label}'s AI spend on ${y}`, bodyMd: `${g.who === 'user' ? 'This person' : 'This repository'} spent $${spent.toFixed(2)} on ${y}, against a median of $${median.toFixed(2)} a day over the two weeks before. Usage shows which tasks it went to; a budget can cap it.`, fixKind: 'investigate' },
    });
  }
  return out;
}

/** Tasks waiting too long in one state. */
export const STUCK_RULES: { statuses: string[]; days: number; why: string }[] = [
  { statuses: ['awaiting_plan_approval', 'awaiting_lld_approval', 'needs_input'], days: 2, why: 'is waiting for a person' },
  { statuses: ['waiting_for_builder'], days: 1, why: 'is waiting for a builder' },
  { statuses: ['queued', 'planning', 'designing', 'coding', 'testing', 'fixing', 'blocked_on_key'], days: 5, why: 'has not moved' },
];
export async function stuckScan(sys: SystemDb, orgId: string, now: Date): Promise<Detection[]> {
  const found = await rows<{ id: string; key: string; title: string; status: string; repo_id: string; since: Date }>(
    sys,
    sql`SELECT t.id, t.key, t.title, t.status, t.repo_id,
               coalesce((SELECT max(e.created_at) FROM task_events e WHERE e.task_id = t.id AND e.to_status = t.status), t.created_at) AS since
          FROM tasks t
         WHERE t.org_id = ${orgId} AND t.status NOT IN ('draft', 'pushed', 'pr_open', 'resolved', 'rejected', 'failed', 'cancelled')`,
  );
  const out: Detection[] = [];
  for (const t of found) {
    const rule = STUCK_RULES.find((r) => r.statuses.includes(t.status));
    if (!rule) continue;
    const days = (now.getTime() - new Date(t.since).getTime()) / 86_400_000;
    if (days < rule.days) continue;
    out.push({
      kind: 'stuck_task',
      severity: days >= 14 ? 'high' : 'medium',
      fingerprint: `stuck:${t.id}:${t.status}`,
      repoId: t.repo_id,
      title: `${t.key} ${rule.why} for ${Math.floor(days)} days`,
      details: { taskId: t.id, taskKey: t.key, taskTitle: t.title, status: t.status, since: t.since, days: Math.floor(days) },
      recommendation: { title: `Unblock ${t.key}`, bodyMd: `${t.key} ("${t.title}") has been in **${t.status.replaceAll('_', ' ')}** for ${Math.floor(days)} days.`, fixKind: 'investigate' },
    });
  }
  return out;
}
