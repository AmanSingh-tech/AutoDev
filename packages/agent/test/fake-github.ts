import { createTwoFilesPatch } from 'diff';
import { createHash } from 'node:crypto';
import { http, HttpResponse } from 'msw';

/**
 * A stateful fake of the GitHub bits the publisher uses: repo permissions, git objects and refs,
 * compare, and pull requests. Enough to check what was pushed and what the PR says.
 */
export function fakeGitHub(api: string, owner: string, repo: string, base: { sha: string; files: Record<string, string>; modes?: Record<string, string> }) {
  const R = `${api}/repos/${owner}/${repo}`;
  const sha = (s: string) => createHash('sha1').update(s).digest('hex');
  const blobs = new Map<string, string>();
  const trees = new Map<string, Record<string, { sha: string; mode: string }>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string; author: string }>();
  const refs = new Map<string, string>([['main', base.sha]]);
  const pulls: { id: number; number: number; head: string; base: string; title: string; body: string; state: string; author: string }[] = [];
  const baseTree: Record<string, { sha: string; mode: string }> = {};
  for (const [p, c] of Object.entries(base.files)) {
    const b = sha(`blob:${c}`);
    blobs.set(b, c);
    baseTree[p] = { sha: b, mode: base.modes?.[p] ?? '100644' };
  }
  trees.set('basetree', baseTree);
  commits.set(base.sha, { tree: 'basetree', parents: [], message: 'base', author: 'someone' });
  const state = { permission: 'push' as 'push' | 'pull', archived: false, blobs, trees, commits, refs, pulls };
  const who = (req: Request) => req.headers.get('authorization')?.replace(/^token /, '') ?? 'anon';
  const files = (commitSha: string) => {
    const t = trees.get(commits.get(commitSha)!.tree)!;
    return Object.fromEntries(Object.entries(t).map(([p, e]) => [p, blobs.get(e.sha)!]));
  };

  const handlers = [
    http.get(R, () => HttpResponse.json({ id: 1, archived: state.archived, permissions: { pull: true, push: state.permission === 'push' } })),
    http.get(`${R}/git/trees/:sha`, ({ params }) => {
      const t = trees.get(params.sha === base.sha ? 'basetree' : (commits.get(params.sha as string)?.tree ?? (params.sha as string)))!;
      return HttpResponse.json({ sha: params.sha, truncated: false, tree: Object.entries(t).map(([path, e]) => ({ path, type: 'blob', sha: e.sha, mode: e.mode, size: blobs.get(e.sha)!.length })) });
    }),
    http.get(`${R}/git/blobs/:sha`, ({ params }) => HttpResponse.json({ encoding: 'base64', content: Buffer.from(blobs.get(params.sha as string) ?? '').toString('base64') })),
    http.get(`${R}/git/ref/:ref`, ({ params }) => {
      const head = refs.get(decodeURIComponent(params.ref as string).replace(/^heads\//, ''));
      return head ? HttpResponse.json({ object: { sha: head } }) : new HttpResponse(null, { status: 404 });
    }),
    http.get(`${R}/compare/:range`, ({ params, request }) => {
      const [b, h] = (params.range as string).split('...');
      let cur: string | undefined = h;
      while (cur && cur !== b) cur = commits.get(cur)?.parents[0];
      if (cur !== b) return HttpResponse.json({ status: 'diverged', files: [] });
      const before = files(b!);
      const after = files(h!);
      const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]);
      // `Accept: application/vnd.github.diff`: the raw diff, as GitHub renders it.
      if (request.headers.get('accept')?.includes('diff'))
        return new HttpResponse(changedPaths.map((p) => `diff --git a/${p} b/${p}\n${createTwoFilesPatch(`a/${p}`, `b/${p}`, before[p] ?? '', after[p] ?? '').split('\n').slice(2).join('\n')}`).join(''), { headers: { 'content-type': 'text/plain' } });
      return HttpResponse.json({ status: 'ahead', files: changedPaths.map((filename) => ({ filename })) });
    }),
    http.get(`${R}/git/commits/:sha`, ({ params }) => HttpResponse.json({ sha: params.sha, tree: { sha: commits.get(params.sha as string)!.tree } })),
    http.post(`${R}/git/blobs`, async ({ request }) => {
      const { content } = (await request.json()) as { content: string };
      const s = sha(`blob:${content}`);
      blobs.set(s, content);
      return HttpResponse.json({ sha: s }, { status: 201 });
    }),
    http.post(`${R}/git/trees`, async ({ request }) => {
      const body = (await request.json()) as { base_tree: string; tree: { path: string; mode: string; sha: string | null }[] };
      const t = { ...trees.get(body.base_tree)! };
      for (const e of body.tree) {
        if (e.sha === null) delete t[e.path];
        else t[e.path] = { sha: e.sha, mode: e.mode };
      }
      const s = sha(JSON.stringify(t));
      trees.set(s, t);
      return HttpResponse.json({ sha: s }, { status: 201 });
    }),
    http.post(`${R}/git/commits`, async ({ request }) => {
      const body = (await request.json()) as { message: string; tree: string; parents: string[] };
      const s = sha(JSON.stringify(body) + Math.random());
      commits.set(s, { ...body, author: who(request) });
      return HttpResponse.json({ sha: s }, { status: 201 });
    }),
    http.post(`${R}/git/refs`, async ({ request }) => {
      const body = (await request.json()) as { ref: string; sha: string };
      refs.set(body.ref.replace('refs/heads/', ''), body.sha);
      return HttpResponse.json({ ref: body.ref }, { status: 201 });
    }),
    http.patch(`${R}/git/refs/:ref`, async ({ request, params }) => {
      const body = (await request.json()) as { sha: string; force: boolean };
      const name = decodeURIComponent(params.ref as string).replace(/^heads\//, '');
      if (!body.force && commits.get(body.sha)?.parents[0] !== refs.get(name)) return HttpResponse.json({ message: 'Update is not a fast forward' }, { status: 422 });
      refs.set(name, body.sha);
      return HttpResponse.json({ object: { sha: body.sha } });
    }),
    http.get(`${R}/pulls`, ({ request }) => {
      const head = new URL(request.url).searchParams.get('head')!.split(':')[1];
      return HttpResponse.json(pulls.filter((p) => p.head === head && p.state === 'open').map(toApi));
    }),
    http.post(`${R}/pulls`, async ({ request }) => {
      const body = (await request.json()) as { head: string; base: string; title: string; body: string };
      const pr = { id: 5000 + pulls.length, number: pulls.length + 1, ...body, state: 'open', author: who(request) };
      pulls.push(pr);
      return HttpResponse.json(toApi(pr), { status: 201 });
    }),
    http.get(`${R}/pulls/:n`, ({ params }) => {
      const pr = pulls.find((p) => p.number === Number(params.n));
      return pr ? HttpResponse.json(toApi(pr)) : new HttpResponse(null, { status: 404 });
    }),
    http.patch(`${R}/pulls/:n`, async ({ request, params }) => {
      const pr = pulls.find((p) => p.number === Number(params.n))!;
      Object.assign(pr, (await request.json()) as { body: string });
      return HttpResponse.json(toApi(pr));
    }),
  ];
  function toApi(p: (typeof pulls)[number]) {
    return { id: p.id, number: p.number, html_url: `https://github.com/${owner}/${repo}/pull/${p.number}`, head: { sha: refs.get(p.head) ?? '', ref: p.head }, base: { ref: p.base }, body: p.body, title: p.title, state: p.state };
  }
  return { handlers, state, files, branchFiles: (b: string) => files(refs.get(b)!) };
}
