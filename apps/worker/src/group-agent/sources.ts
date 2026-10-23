import type { Dependency, Ecosystem } from './lockfiles';

/**
 * Outside data for dependency scans. Only package names and versions leave AutoDev, never code.
 * Base URLs come from the environment (GroupAgentEnv), so tests point them at a mock.
 */
export interface SourceUrls {
  OSV_API_URL: string;
  NPM_REGISTRY_URL: string;
  PYPI_URL: string;
  GOPROXY_URL: string;
}

export interface Advisory {
  id: string;
  summary: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** The lowest fixed version for this package, when the advisory names one. */
  fixedVersion: string | null;
  url: string;
}

const TIMEOUT_MS = 15_000;
/** OSV's querybatch limit. */
const OSV_BATCH = 1000;

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

type OsvVuln = {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: { package?: { name: string; ecosystem: string }; ranges?: { events: Record<string, string>[] }[] }[];
};

/** GHSA labels first; otherwise the CVSS base score when OSV gives it as a number. */
function severityOf(v: OsvVuln): Advisory['severity'] {
  const label = v.database_specific?.severity?.toUpperCase();
  if (label === 'CRITICAL') return 'critical';
  if (label === 'HIGH') return 'high';
  if (label === 'MODERATE' || label === 'MEDIUM') return 'medium';
  if (label === 'LOW') return 'low';
  const score = Number(v.severity?.find((s) => /^\d+(\.\d+)?$/.test(s.score))?.score);
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'medium';
}

function fixedFor(v: OsvVuln, dep: Pick<Dependency, 'name' | 'ecosystem'>): string | null {
  const fixes = (v.affected ?? [])
    .filter((a) => a.package?.name === dep.name && a.package?.ecosystem === dep.ecosystem)
    .flatMap((a) => (a.ranges ?? []).flatMap((r) => r.events.map((e) => e.fixed).filter((f): f is string => !!f)));
  return fixes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] ?? null;
}

/** Advisories for each dependency (by index). Details are fetched once per advisory id per run. */
export async function advisoriesFor(urls: SourceUrls, deps: Dependency[]): Promise<Map<number, Advisory[]>> {
  const out = new Map<number, Advisory[]>();
  const details = new Map<string, OsvVuln | null>();
  for (let start = 0; start < deps.length; start += OSV_BATCH) {
    const batch = deps.slice(start, start + OSV_BATCH);
    const res = await getJson<{ results: { vulns?: { id: string }[] }[] }>(`${urls.OSV_API_URL}/v1/querybatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: batch.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
    });
    for (const [i, r] of (res?.results ?? []).entries()) {
      const ids = (r.vulns ?? []).map((v) => v.id);
      if (!ids.length) continue;
      const advisories: Advisory[] = [];
      for (const id of ids) {
        if (!details.has(id)) details.set(id, await getJson<OsvVuln>(`${urls.OSV_API_URL}/v1/vulns/${encodeURIComponent(id)}`));
        const v = details.get(id);
        if (!v) continue;
        advisories.push({
          id: v.aliases?.find((a) => a.startsWith('CVE-')) ?? v.id,
          summary: (v.summary ?? v.details ?? v.id).split('\n')[0]!.slice(0, 200),
          severity: severityOf(v),
          fixedVersion: fixedFor(v, batch[i]!),
          url: `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`,
        });
      }
      if (advisories.length) out.set(start + i, advisories);
    }
  }
  return out;
}

/** The newest stable release of a package, or null if the registry doesn't know it. */
export async function latestVersion(urls: SourceUrls, ecosystem: Ecosystem, name: string): Promise<string | null> {
  if (ecosystem === 'npm') {
    const r = await getJson<{ version?: string }>(`${urls.NPM_REGISTRY_URL}/${name.replace('/', '%2F')}/latest`);
    return r?.version ?? null;
  }
  if (ecosystem === 'PyPI') {
    const r = await getJson<{ info?: { version?: string } }>(`${urls.PYPI_URL}/pypi/${encodeURIComponent(name)}/json`);
    return r?.info?.version ?? null;
  }
  // Go module paths escape capitals as !lowercase.
  const path = name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
  const r = await getJson<{ Version?: string }>(`${urls.GOPROXY_URL}/${path}/@latest`);
  return r?.Version?.replace(/^v/, '') ?? null;
}
