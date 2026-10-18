/** Mirrors packages/db/src/seed.ts (same fake GitHub ids), so e2e runs against the demo org. */
export const USERS = {
  'demo-owner': { id: 900_001, login: 'demo-owner', name: 'Olivia Owner', orgRole: 'admin' },
  'demo-admin': { id: 900_002, login: 'demo-admin', name: 'Adrian Admin', orgRole: 'admin' },
  'demo-dev': { id: 900_003, login: 'demo-dev', name: 'Devi Developer', orgRole: 'member' },
  'demo-viewer': { id: 900_004, login: 'demo-viewer', name: 'Victor Viewer', orgRole: 'member' },
} as const;
export type Login = keyof typeof USERS;

export const ORG = { id: 900_100, login: 'acme-demo' };
export const INSTALLATION_ID = 900_200;

type Perm = 'admin' | 'maintain' | 'push' | 'triage' | 'pull';
const REPOS: { id: number; name: string; perms: Partial<Record<Login, Perm>> }[] = [
  { id: 900_300, name: 'web', perms: { 'demo-dev': 'push' } },
  { id: 900_301, name: 'api', perms: { 'demo-dev': 'admin' } },
  { id: 900_302, name: 'infra', perms: { 'demo-dev': 'maintain' } },
  { id: 900_303, name: 'docs', perms: { 'demo-dev': 'pull' } },
];

const LEVELS: Perm[] = ['pull', 'triage', 'push', 'maintain', 'admin'];

function flags(level: Perm) {
  const at = LEVELS.indexOf(level);
  return Object.fromEntries(LEVELS.map((l, i) => [l, i <= at]));
}

export function reposFor(login: Login) {
  const isOrgAdmin = USERS[login].orgRole === 'admin';
  return REPOS.map((r) => ({
    id: r.id,
    name: r.name,
    full_name: `${ORG.login}/${r.name}`,
    owner: { login: ORG.login, id: ORG.id },
    default_branch: 'main',
    private: true,
    archived: false,
    permissions: flags(isOrgAdmin ? 'admin' : (r.perms[login] ?? 'pull')),
  }));
}
