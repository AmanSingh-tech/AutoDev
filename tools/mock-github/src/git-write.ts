import { createHash } from 'node:crypto';
import { blob as repoBlob, headSha, tree as repoTree } from './repo';

/**
 * In-memory git writes and pull requests on top of the (read-only) demo repo, for the e2e flow:
 * the publisher's blobs → tree → commit → ref, and PR create/update. Inspect with GET /_mock/pulls.
 */
type Entry = { sha: string; mode: string };
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const blobs = new Map<string, string>();
const trees = new Map<string, Record<string, Entry>>();
const commits = new Map<string, { tree: string; parents: string[]; message: string; author: string }>();
const refs = new Map<string, string>();
export const pulls: { id: number; number: number; head: string; base: string; title: string; body: string; state: 'open' | 'closed'; author: string; repo: string }[] = [];

function baseTreeFor(commit: string) {
  if (commits.has(commit)) return commits.get(commit)!.tree;
  const key = `base:${commit}`;
  if (!trees.has(key)) trees.set(key, Object.fromEntries(repoTree().filter((e) => e.type === 'blob').map((e) => [e.path, { sha: e.sha, mode: e.mode }])));
  return key;
}

export function handleGitWrite(method: string, path: string, body: Record<string, unknown> | null, user: string): { status: number; body: unknown } | null {
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/repos\/[^/]+\/([^/]+)\/git\/ref\/(.+)$/)) && method === 'GET') {
    const name = decodeURIComponent(m[2]!).replace(/^heads\//, '');
    const sha = refs.get(name) ?? (['main', 'develop', 'feature/sso-login'].includes(name) ? headSha(name) : null);
    return sha ? { status: 200, body: { object: { sha } } } : { status: 404, body: { message: 'Not Found' } };
  }
  if ((m = path.match(/^\/repos\/[^/]+\/[^/]+\/git\/commits\/(.+)$/)) && method === 'GET') {
    return { status: 200, body: { sha: m[1], tree: { sha: baseTreeFor(m[1]!) } } };
  }
  if (path.match(/\/git\/blobs$/) && method === 'POST') {
    const content = String(body!.content);
    const s = sha1(`blob:${content}`);
    blobs.set(s, content);
    return { status: 201, body: { sha: s } };
  }
  if (path.match(/\/git\/trees$/) && method === 'POST') {
    const t = { ...(trees.get(String(body!.base_tree)) ?? {}) };
    for (const e of body!.tree as { path: string; mode: string; sha: string | null }[]) {
      if (e.sha === null) delete t[e.path];
      else t[e.path] = { sha: e.sha, mode: e.mode };
    }
    const s = sha1(JSON.stringify(t));
    trees.set(s, t);
    return { status: 201, body: { sha: s } };
  }
  if (path.match(/\/git\/commits$/) && method === 'POST') {
    const s = sha1(JSON.stringify(body) + Date.now());
    commits.set(s, { tree: String(body!.tree), parents: body!.parents as string[], message: String(body!.message), author: user });
    return { status: 201, body: { sha: s } };
  }
  if (path.match(/\/git\/refs$/) && method === 'POST') {
    refs.set(String(body!.ref).replace('refs/heads/', ''), String(body!.sha));
    return { status: 201, body: { ref: body!.ref } };
  }
  if ((m = path.match(/\/git\/refs\/(.+)$/)) && method === 'PATCH') {
    refs.set(decodeURIComponent(m[1]!).replace(/^heads\//, ''), String(body!.sha));
    return { status: 200, body: { object: { sha: body!.sha } } };
  }
  if ((m = path.match(/^\/repos\/[^/]+\/[^/]+\/compare\/(.+)\.\.\.(.+)$/)) && method === 'GET') {
    return { status: 200, body: { status: m[1] === m[2] ? 'identical' : 'ahead', files: [] } };
  }
  if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
    const repo = `${m[1]}/${m[2]}`;
    if (method === 'GET') return { status: 200, body: pulls.filter((p) => p.repo === repo && p.state === 'open').map(toApi) };
    const pr = { id: 70_000 + pulls.length, number: pulls.length + 1, head: String(body!.head), base: String(body!.base), title: String(body!.title), body: String(body!.body), state: 'open' as const, author: user, repo };
    pulls.push(pr);
    return { status: 201, body: toApi(pr) };
  }
  if ((m = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/)) && method === 'PATCH') {
    const pr = pulls.find((p) => p.number === Number(m![1]))!;
    if (typeof body!.body === 'string') pr.body = body!.body;
    return { status: 200, body: toApi(pr) };
  }
  return null;
}

/** Files on a branch after the publisher's commits (for the test to check). */
export function branchFiles(branch: string): Record<string, string> {
  const head = refs.get(branch);
  if (!head) return {};
  const t = trees.get(commits.get(head)?.tree ?? baseTreeFor(head))!;
  return Object.fromEntries(Object.entries(t).map(([p, e]) => [p, blobs.get(e.sha) ?? repoBlob(e.sha)?.toString() ?? '']));
}

function toApi(p: (typeof pulls)[number]) {
  return { id: p.id, number: p.number, html_url: `https://github.com/${p.repo}/pull/${p.number}`, head: { ref: p.head, sha: refs.get(p.head) ?? '' }, base: { ref: p.base }, body: p.body, title: p.title, state: p.state };
}
