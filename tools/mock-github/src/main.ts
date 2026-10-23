/**
 * A tiny stand-in for github.com + api.github.com (and Anthropic's /v1/models), used by Playwright.
 * OAuth signs you in as MOCK_GITHUB_LOGIN (default demo-dev). Visit /_login-as?login=demo-owner first
 * to pick someone else (a cookie on the mock's origin).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { anthropicMessages } from './anthropic';
import { branchFiles, handleGitWrite, pulls } from './git-write';
import { blob as repoBlob, headSha, tree as repoTree } from './repo';
import { INSTALLATION_ID, ORG, reposFor, USERS, WORST_INSTALLATION_ID, WORST_ORG, WORST_USER, worstReposFor, type Login } from './data';

const PORT = Number(process.env.MOCK_GITHUB_PORT ?? 4010);
const DEFAULT_LOGIN = (process.env.MOCK_GITHUB_LOGIN ?? 'demo-dev') as Login;
const codes = new Map<string, Login>();

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** What the App's installation token reads with (background jobs such as the code index). */
const INSTALLATION_TOKEN = 'ghs_mock_installation';
const tokenOf = (req: IncomingMessage) => req.headers.authorization?.replace(/^(token|bearer)\s+/i, '');

const userFromAuth = (req: IncomingMessage): Login | null => {
  const token = req.headers.authorization?.replace(/^(token|bearer)\s+/i, '');
  const login = token?.startsWith('ghu_mock_') ? token.slice('ghu_mock_'.length) : null;
  return login && login in USERS ? (login as Login) : null;
};

/** Trees, blobs and branches: what both people and the installation token may read. */
function readContents(api: string): { status: number; body: unknown } | null {
  const tree = api.match(/^\/repos\/[^/]+\/[^/]+\/git\/trees\/(.+)$/);
  if (tree) return { status: 200, body: { sha: tree[1], truncated: false, tree: repoTree() } };
  const blob = api.match(/^\/repos\/[^/]+\/[^/]+\/git\/blobs\/(.+)$/);
  if (blob) {
    const content = repoBlob(blob[1]!);
    return content ? { status: 200, body: { sha: blob[1], encoding: 'base64', content: content.toString('base64') } } : { status: 404, body: { message: 'Not Found' } };
  }
  const branches = api.match(/^\/repos\/([^/]+)\/([^/]+)\/branches(?:\/(.+))?$/);
  if (branches) {
    const all = ['main', 'develop', 'feature/sso-login'].map((name) => ({ name, commit: { sha: headSha(name) }, protected: name === 'main' }));
    if (!branches[3]) return { status: 200, body: all };
    const b = all.find((x) => x.name === decodeURIComponent(branches[3]!));
    return b ? { status: 200, body: b } : { status: 404, body: { message: 'Branch not found' } };
  }
  return null;
}

async function readBody(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if ((req.headers['content-type'] ?? '').includes('json')) return JSON.parse(raw || '{}');
  return Object.fromEntries(new URLSearchParams(raw));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/_login-as') {
    const login = url.searchParams.get('login') ?? DEFAULT_LOGIN;
    res.writeHead(200, { 'set-cookie': `mock_login=${encodeURIComponent(login)}; Path=/; SameSite=Lax`, 'content-type': 'text/plain' });
    return res.end(`next sign-in will be ${login}`);
  }

  // Anthropic key validation: keys starting with sk-ant-good are accepted.
  if (path === '/anthropic/v1/models') {
    return req.headers['x-api-key']?.toString().startsWith('sk-ant-good')
      ? json(res, 200, { data: [{ id: 'claude-opus-5-5', type: 'model' }], has_more: false })
      : json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  }

  // OSV.dev and the npm registry, for the Group Agent's dependency scan: lodash below 4.17.21 has one advisory.
  if (path === '/osv/v1/querybatch' && req.method === 'POST') {
    const body = (await readBody(req)) as { queries: { package: { name: string }; version: string }[] };
    const vulnerable = (q: { package: { name: string }; version: string }) => q.package.name === 'lodash' && q.version.localeCompare('4.17.21', undefined, { numeric: true }) < 0;
    return json(res, 200, { results: body.queries.map((q) => (vulnerable(q) ? { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] } : {})) });
  }
  if (path.startsWith('/osv/v1/vulns/')) {
    return json(res, 200, {
      id: 'GHSA-35jh-r3h4-6jhm',
      aliases: ['CVE-2021-23337'],
      summary: 'Command injection in lodash',
      database_specific: { severity: 'HIGH' },
      affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
    });
  }
  const npmLatest = path.match(/^\/npm\/(.+)\/latest$/);
  if (npmLatest) return json(res, 200, { version: decodeURIComponent(npmLatest[1]!) === 'lodash' ? '4.17.21' : '1.0.0' });
  if (path === '/anthropic/v1/messages' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return anthropicMessages(raw, res);
  }

  if (path === '/_mock/pulls') {
    const branch = url.searchParams.get('branch');
    return json(res, 200, { pulls, files: branch ? branchFiles(branch) : null });
  }

  if (path === '/login/oauth/authorize') {
    const cookie = /(?:^|;\s*)mock_login=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const login = (url.searchParams.get('login_as') ?? (cookie ? decodeURIComponent(cookie) : DEFAULT_LOGIN)) as Login;
    const code = `code_${Math.random().toString(36).slice(2)}`;
    codes.set(code, login);
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', code);
    if (url.searchParams.get('state')) back.searchParams.set('state', url.searchParams.get('state')!);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  if (path === '/login/oauth/access_token' && req.method === 'POST') {
    const body = await readBody(req);
    const login = codes.get(body.code);
    if (!login) return json(res, 200, { error: 'bad_verification_code' });
    codes.delete(body.code);
    return json(res, 200, {
      access_token: `ghu_mock_${login}`,
      token_type: 'bearer',
      scope: '',
      expires_in: 28_800,
      refresh_token: `ghr_mock_${login}`,
      refresh_token_expires_in: 15_811_200,
    });
  }

  if (!path.startsWith('/api/')) return json(res, 404, { message: 'Not Found' });

  // The App exchanges its JWT for an installation token. The JWT isn't checked: the mock trusts the App.
  if (req.method === 'POST' && /^\/api\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    return json(res, 201, { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: 'read' } });
  }
  // The installation token reads repo contents only.
  if (tokenOf(req) === INSTALLATION_TOKEN && req.method === 'GET') {
    const out = readContents(path.slice('/api'.length));
    return out ? json(res, out.status, out.body) : json(res, 404, { message: 'Not Found' });
  }

  const login = userFromAuth(req);
  if (!login) return json(res, 401, { message: 'Bad credentials' });
  const user = USERS[login];
  const api = path.slice('/api'.length);

  if (req.method !== 'GET' || /\/git\/(ref|commits)\/|\/compare\/|\/pulls/.test(api)) {
    const body = req.method === 'GET' ? null : ((await readBody(req)) as Record<string, unknown>);
    const out = handleGitWrite(req.method ?? 'GET', api, body, login);
    if (out) return json(res, out.status, out.body);
  }

  if (api === '/user') {
    return json(res, 200, { id: user.id, login: user.login, name: user.name, email: null, avatar_url: null });
  }
  if (api === '/user/installations') {
    return json(res, 200, {
      total_count: 1,
      // Each person sees one org: the demo users acme-demo, the worst-case user the worst-case org.
      installations: [login === WORST_USER ? WORST_ORG : ORG].map((o) => ({
        id: o === ORG ? INSTALLATION_ID : WORST_INSTALLATION_ID,
        target_type: 'Organization',
        account: { id: o.id, login: o.login, type: 'Organization' },
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', members: 'read' },
        events: [],
      })),
    });
  }
  if (api === `/user/installations/${INSTALLATION_ID}/repositories`) {
    const repositories = reposFor(login);
    return json(res, 200, { total_count: repositories.length, repositories });
  }
  if (api === `/user/installations/${WORST_INSTALLATION_ID}/repositories`) {
    const repositories = worstReposFor(login);
    return json(res, 200, { total_count: repositories.length, repositories });
  }
  if (api === `/user/memberships/orgs/${ORG.login}` || api === `/user/memberships/orgs/${WORST_ORG.login}`) {
    return json(res, 200, { state: 'active', role: user.orgRole });
  }
  const contents = readContents(api);
  if (contents) return json(res, contents.status, contents.body);
  // Code search finds the one source file of the demo repo.
  if (api === '/search/code') return json(res, 200, { total_count: 1, incomplete_results: false, items: [{ name: 'app.ts', path: 'src/app.ts', sha: 'x' }] });
  const repo = api.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    const r = reposFor(login).find((x) => x.full_name === `${repo[1]}/${repo[2]}`);
    return r ? json(res, 200, r) : json(res, 404, { message: 'Not Found' });
  }
  return json(res, 404, { message: 'Not Found' });
}).listen(PORT, () => console.log(`mock-github listening on :${PORT}`));
