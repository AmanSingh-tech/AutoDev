/**
 * A tiny stand-in for github.com + api.github.com, used by Playwright.
 * OAuth signs you in as MOCK_GITHUB_LOGIN (default demo-dev), or as `?login_as=` on the authorize URL.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { INSTALLATION_ID, ORG, reposFor, USERS, type Login } from './data';

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

  if (path === '/login/oauth/authorize') {
    const login = (url.searchParams.get('login_as') ?? DEFAULT_LOGIN) as Login;
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

  if (api === '/user') {
    return json(res, 200, { id: user.id, login: user.login, name: user.name, email: null, avatar_url: null });
  }
  if (api === '/user/installations') {
    return json(res, 200, {
      total_count: 1,
      installations: [
        {
          id: INSTALLATION_ID,
          target_type: 'Organization',
          account: { id: ORG.id, login: ORG.login, type: 'Organization' },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', members: 'read' },
          events: [],
        },
      ],
    });
  }
  if (api === `/user/installations/${INSTALLATION_ID}/repositories`) {
    const repositories = reposFor(login);
    return json(res, 200, { total_count: repositories.length, repositories });
  }
  if (api === `/user/memberships/orgs/${ORG.login}`) {
    return json(res, 200, { state: 'active', role: user.orgRole });
  }
  const repo = api.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    const r = reposFor(login).find((x) => x.full_name === `${repo[1]}/${repo[2]}`);
    return r ? json(res, 200, r) : json(res, 404, { message: 'Not Found' });
  }
  return json(res, 404, { message: 'Not Found' });
}).listen(PORT, () => console.log(`mock-github listening on :${PORT}`));
