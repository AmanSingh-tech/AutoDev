export class PathError extends Error {
  override name = 'PathError';
}

/** Normalizes a repo-relative path. Rejects anything that could escape the repo. */
export function normalizePath(input: string): string {
  if (typeof input !== 'string') throw new PathError('path must be a string');
  if (input.includes('\0') || input.includes('\\')) throw new PathError('path contains forbidden characters');
  const p = input.trim().replace(/^\.\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (p === '' || p === '.') return '';
  if (p.startsWith('/')) throw new PathError('use a path relative to the repository root');
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.')) throw new PathError('".." and "." segments are not allowed');
  if (segs[0] === '.git') throw new PathError('.git is not accessible');
  return p;
}

export const isWithin = (path: string, dir: string) => dir === '' || path === dir || path.startsWith(`${dir}/`);

/** GitHub rejects workflow pushes without the Workflows permission, which the App deliberately lacks. */
const PROTECTED = [/^\.github\/workflows(\/|$)/];

export interface PathPolicy {
  /** scope_path: reads and edits outside it are refused. */
  scope: string;
}

export function assertReadable(path: string, policy: PathPolicy) {
  if (!isWithin(path, policy.scope)) throw new PathError(`"${path || '.'}" is outside this task's folder "${policy.scope}"`);
}

export function assertWritable(path: string, policy: PathPolicy) {
  if (!path) throw new PathError('a file path is required');
  assertReadable(path, policy);
  if (PROTECTED.some((re) => re.test(path))) {
    throw new PathError(`"${path}" can't be changed by AutoDev (GitHub workflow files need a permission the App doesn't have)`);
  }
}

/** Changing the test configuration needs the user's consent before the builder runs it (A-5). */
export const isBuilderConfig = (path: string) => path === '.autodev.yml' || path === '.autodev.yaml';
