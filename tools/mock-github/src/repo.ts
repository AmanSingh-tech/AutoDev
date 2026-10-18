import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { REPO_FILES } from './anthropic';

/**
 * Git data for the demo repos. With MOCK_REPO_DIR set (the e2e fixture), everything comes from a
 * real local git repository, so a builder can apply patches to a real commit. Otherwise it's the
 * in-memory REPO_FILES with fake shas.
 */
const dir = () => (process.env.MOCK_REPO_DIR && existsSync(`${process.env.MOCK_REPO_DIR}/.git`) ? process.env.MOCK_REPO_DIR : null);
const git = (args: string[]) => execFileSync('git', args, { cwd: dir()!, maxBuffer: 50 * 1024 * 1024 });

export function headSha(branch: string): string {
  return dir() ? git(['rev-parse', 'HEAD']).toString().trim() : `sha-${branch}`;
}

export function tree() {
  if (!dir()) {
    return [
      ...Object.entries(REPO_FILES).map(([p, c]) => ({ path: p, type: 'blob', mode: '100644', sha: `blob:${p}`, size: Buffer.byteLength(c) })),
      { path: 'src', type: 'tree', mode: '040000', sha: 'tree:src' },
    ];
  }
  return git(['ls-tree', '-r', '-t', '-l', 'HEAD'])
    .toString()
    .trim()
    .split('\n')
    .map((line) => {
      const [meta, path] = line.split('\t');
      const [mode, type, sha, size] = meta!.split(/\s+/);
      return { path: path!, type: type!, mode: mode!, sha: sha!, ...(size !== '-' ? { size: Number(size) } : {}) };
    });
}

export function blob(sha: string): Buffer | null {
  if (!dir()) {
    const c = REPO_FILES[decodeURIComponent(sha).replace(/^blob:/, '')];
    return c === undefined ? null : Buffer.from(c);
  }
  try {
    return git(['cat-file', 'blob', sha]);
  } catch {
    return null;
  }
}
