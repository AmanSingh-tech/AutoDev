import { parse as parseYaml } from 'yaml';

/**
 * Dependency lists from lockfiles and manifests (B-5). Pure: text in, packages out. Ecosystem names
 * are OSV's ("npm", "PyPI", "Go"). `direct` marks what the repo depends on itself, which is what
 * "outdated" checks and bump recommendations are about; vulnerabilities count for every package.
 */
export type Ecosystem = 'npm' | 'PyPI' | 'Go';

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  direct: boolean;
  /** The lockfile it came from, repo-relative. */
  file: string;
}

/** File names this scan reads, wherever they are in the repo (outside vendored folders). */
export const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'poetry.lock', 'go.mod'] as const;
const SKIP_DIR = /(^|\/)(node_modules|vendor|\.git|dist|build|third_party)\//;
/** Lockfiles read per repo; monorepos with more get the shallowest ones. */
export const MAX_LOCKFILES = 20;

export function lockfilePaths(paths: string[]): string[] {
  return paths
    .filter((p) => !SKIP_DIR.test(p) && (LOCKFILES as readonly string[]).includes(p.split('/').pop()!))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, MAX_LOCKFILES);
}

export function parseLockfile(path: string, text: string): Dependency[] {
  const name = path.split('/').pop();
  try {
    if (name === 'package-lock.json') return packageLock(path, text);
    if (name === 'pnpm-lock.yaml') return pnpmLock(path, text);
    if (name === 'yarn.lock') return yarnLock(path, text);
    if (name === 'requirements.txt') return requirements(path, text);
    if (name === 'poetry.lock') return poetryLock(path, text);
    if (name === 'go.mod') return goMod(path, text);
  } catch {
    // A file we can't parse is skipped, not fatal: the other lockfiles still count.
  }
  return [];
}

const dedupe = (deps: Dependency[]) => {
  const seen = new Map<string, Dependency>();
  for (const d of deps) {
    const key = `${d.ecosystem}:${d.name}@${d.version}`;
    const prev = seen.get(key);
    if (!prev || (d.direct && !prev.direct)) seen.set(key, d);
  }
  return [...seen.values()];
};

/** npm lockfile v2/v3: `packages` keyed by node_modules path; the root entry lists direct deps. */
function packageLock(file: string, text: string): Dependency[] {
  const lock = JSON.parse(text) as { packages?: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };
  const pkgs = lock.packages ?? {};
  const root = pkgs[''] ?? {};
  const direct = new Set([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {})]);
  const out: Dependency[] = [];
  for (const [path, p] of Object.entries(pkgs)) {
    if (!path || !p.version) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const topLevel = path === `node_modules/${name}`;
    out.push({ ecosystem: 'npm', name, version: p.version, direct: topLevel && direct.has(name), file });
  }
  return dedupe(out);
}

/** pnpm lockfile v6–v9: importers list direct deps; `packages` keys are `name@version` (v9) or `/name@version` (v6). */
function pnpmLock(file: string, text: string): Dependency[] {
  const lock = parseYaml(text) as {
    importers?: Record<string, { dependencies?: Record<string, { version: string } | string>; devDependencies?: Record<string, { version: string } | string> }>;
    packages?: Record<string, unknown>;
  };
  const direct = new Set<string>();
  for (const imp of Object.values(lock.importers ?? {})) {
    for (const [name, v] of Object.entries({ ...(imp.dependencies ?? {}), ...(imp.devDependencies ?? {}) })) {
      const version = (typeof v === 'string' ? v : v.version).split('(')[0]!;
      if (!version.startsWith('link:')) direct.add(`${name}@${version}`);
    }
  }
  const out: Dependency[] = [];
  for (const key of Object.keys(lock.packages ?? {})) {
    const k = key.replace(/^\//, '').split('(')[0]!;
    const at = k.lastIndexOf('@');
    if (at <= 0) continue;
    const name = k.slice(0, at);
    const version = k.slice(at + 1);
    out.push({ ecosystem: 'npm', name, version, direct: direct.has(`${name}@${version}`), file });
  }
  return dedupe(out);
}

/** Yarn v1 and Berry: blocks headed by `"name@range", name@range:` with a `version` line. Direct deps aren't knowable here. */
function yarnLock(file: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  let names: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\S.*:\s*$/.test(line) && !line.startsWith('#') && !line.startsWith('__metadata')) {
      names = line
        .replace(/:\s*$/, '')
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        // `lodash@^4.17.0`, `"@babel/core@^7.0.0"`, Berry's `lodash@npm:^4.17.21`: the name is before the last @.
        .map((spec) => (spec.lastIndexOf('@') > 0 ? spec.slice(0, spec.lastIndexOf('@')) : spec));
      continue;
    }
    const v = line.match(/^\s+version:?\s+"?([^"\s]+)"?/);
    if (v && names.length) {
      out.push({ ecosystem: 'npm', name: names[0]!, version: v[1]!, direct: false, file });
      names = [];
    }
  }
  return dedupe(out);
}

/** Only exact pins (`name==1.2.3`); ranges have no single version to check. */
function requirements(file: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]!.trim();
    const m = line.match(/^([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*==\s*([A-Za-z0-9_.+!-]+)/);
    if (m) out.push({ ecosystem: 'PyPI', name: m[1]!.toLowerCase(), version: m[3]!, direct: true, file });
  }
  return dedupe(out);
}

/** `[[package]]` blocks with name and version. poetry.lock doesn't say which are direct. */
function poetryLock(file: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) out.push({ ecosystem: 'PyPI', name: name.toLowerCase(), version, direct: false, file });
  }
  return dedupe(out);
}

/** `require` lines, single or in a block; `// indirect` marks transitive ones. */
function goMod(file: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('require (')) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const m = (inBlock ? line : line.startsWith('require ') ? line.slice(8).trim() : '').match(/^(\S+)\s+(v\S+)(\s+\/\/\s*indirect)?/);
    if (m) out.push({ ecosystem: 'Go', name: m[1]!, version: m[2]!.replace(/^v/, ''), direct: !m[3], file });
  }
  return dedupe(out);
}

/** major.minor.patch of a version string; null for anything that isn't plain numbers (pre-releases, dates). */
export function parseVersion(v: string): [number, number, number] | null {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** How `latest` differs from `current`: 'patch', 'minor', 'major', or null when it isn't newer or isn't comparable. */
export function bumpKind(current: string, latest: string): 'patch' | 'minor' | 'major' | null {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return null;
  if (b[0] !== a[0]) return b[0] > a[0] ? 'major' : null;
  if (b[1] !== a[1]) return b[1] > a[1] ? 'minor' : null;
  return b[2] > a[2] ? 'patch' : null;
}
