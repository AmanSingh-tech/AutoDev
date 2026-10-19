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

const userFromAuth = (req: IncomingMessage): Login | null => {
  const token = req.headers.authorization?.replace(/^(token|bearer)\s+/i, '');
  const login = token?.startsWith('ghu_mock_') ? token.slice('ghu_mock_'.length) : null;
  return login && login in USERS ? (login as Login) : null;
};

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
  const tree = api.match(/^\/repos\/[^/]+\/[^/]+\/git\/trees\/(.+)$/);
  if (tree) return json(res, 200, { sha: tree[1], truncated: false, tree: repoTree() });
  const blob = api.match(/^\/repos\/[^/]+\/[^/]+\/git\/blobs\/(.+)$/);
  if (blob) {
    const content = repoBlob(blob[1]!);
    return content ? json(res, 200, { sha: blob[1], encoding: 'base64', content: content.toString('base64') }) : json(res, 404, { message: 'Not Found' });
  }
  const branches = api.match(/^\/repos\/([^/]+)\/([^/]+)\/branches(?:\/(.+))?$/);
  if (branches) {
    const all = ['main', 'develop', 'feature/sso-login'].map((name) => ({ name, commit: { sha: headSha(name) }, protected: name === 'main' }));
    if (!branches[3]) return json(res, 200, all);
    const b = all.find((x) => x.name === decodeURIComponent(branches[3]!));
    return b ? json(res, 200, b) : json(res, 404, { message: 'Branch not found' });
  }
  const repo = api.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    const r = reposFor(login).find((x) => x.full_name === `${repo[1]}/${repo[2]}`);
    return r ? json(res, 200, r) : json(res, 404, { message: 'Not Found' });
  }
  return json(res, 404, { message: 'Not Found' });
}).listen(PORT, () => console.log(`mock-github listening on :${PORT}`));
