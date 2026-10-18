import type { TreeEntry } from '@autodev/github';
import { createTwoFilesPatch } from 'diff';
import type { OverlayEntry, OverlayStore } from './overlay';
import { assertReadable, assertWritable, isBuilderConfig, isWithin, normalizePath, PathError, type PathPolicy } from './paths';
import type { RepoReader } from './repo-reader';

export const MAX_FILE_BYTES = 1024 * 1024;
const GREP_MAX_FILES = 400;
const GREP_MAX_BYTES = 8 * 1024 * 1024;
const GREP_MAX_RESULTS = 200;

/** A failed workspace operation, reported back to the model as a tool error (not a crash). */
export class WorkspaceError extends Error {
  override name = 'WorkspaceError';
}

export interface DirEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface FileChange {
  path: string;
  op: 'create' | 'modify' | 'delete';
}

/**
 * The repo at the base SHA plus an overlay of the agent's edits. There's no clone: reads come from
 * GitHub (cached), and writes go to the overlay in Postgres. scope_path and protected paths are enforced here,
 * so no tool can bypass them.
 */
export class VirtualWorkspace {
  constructor(
    private readonly reader: RepoReader,
    private readonly overlay: OverlayStore,
    private readonly policy: PathPolicy,
  ) {}

  get scope() {
    return this.policy.scope;
  }

  private path(input: string, mode: 'read' | 'write'): string {
    try {
      const p = normalizePath(input);
      if (mode === 'write') assertWritable(p, this.policy);
      else assertReadable(p, this.policy);
      return p;
    } catch (e) {
      if (e instanceof PathError) throw new WorkspaceError(e.message);
      throw e;
    }
  }

  private async baseEntry(path: string): Promise<TreeEntry | null> {
    const { entries, truncated } = await this.reader.tree();
    const hit = entries.find((e) => e.path === path);
    if (hit || !truncated) return hit ?? null;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return (await this.reader.listDir(parent)).find((e) => e.path === path) ?? null;
  }

  async exists(input: string): Promise<boolean> {
    const p = this.path(input, 'read');
    const o = await this.overlay.get(p);
    if (o) return o.op !== 'delete';
    return (await this.baseEntry(p))?.type === 'blob';
  }

  async listDir(input = ''): Promise<DirEntry[]> {
    const dir = this.path(input || this.policy.scope, 'read');
    const { entries, truncated } = await this.reader.tree();
    const base = truncated ? await this.reader.listDir(dir) : entries.filter((e) => isDirectChild(e.path, dir));
    const out = new Map<string, DirEntry>();
    for (const e of base) out.set(e.path, { path: e.path, type: e.type === 'tree' ? 'dir' : 'file', ...(e.size !== undefined ? { size: e.size } : {}) });
    for (const o of await this.overlay.list()) {
      if (!isWithin(o.path, dir) || o.path === dir) continue;
      const rest = o.path.slice(dir ? dir.length + 1 : 0);
      const child = dir ? `${dir}/${rest.split('/')[0]}` : rest.split('/')[0]!;
      if (rest.includes('/')) {
        if (o.op !== 'delete') out.set(child, { path: child, type: 'dir' });
      } else if (o.op === 'delete') out.delete(o.path);
      else out.set(o.path, { path: o.path, type: 'file', size: Buffer.byteLength(o.content ?? '') });
    }
    if (!out.size && dir && !(await this.isDir(dir))) throw new WorkspaceError(`"${dir}" is not a directory`);
    return [...out.values()].sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
  }

  private async isDir(dir: string) {
    const e = await this.baseEntry(dir);
    return e?.type === 'tree' || (await this.overlay.list()).some((o) => o.op !== 'delete' && o.path.startsWith(`${dir}/`));
  }

  async readFile(input: string): Promise<string> {
    const p = this.path(input, 'read');
    const o = await this.overlay.get(p);
    if (o) {
      if (o.op === 'delete') throw new WorkspaceError(`"${p}" was deleted in this task`);
      return o.content ?? '';
    }
    return this.readBase(p);
  }

  private async readBase(p: string): Promise<string> {
    const e = await this.baseEntry(p);
    if (!e) throw new WorkspaceError(`"${p}" does not exist`);
    if (e.type === 'tree') throw new WorkspaceError(`"${p}" is a directory; use list_dir`);
    if ((e.size ?? 0) > MAX_FILE_BYTES) throw new WorkspaceError(`"${p}" is larger than 1 MB and can't be opened`);
    const buf = await this.reader.readBlob(e.sha);
    if (buf.includes(0)) throw new WorkspaceError(`"${p}" is a binary file`);
    return buf.toString('utf8');
  }

  /** Exact string replace. old_string must appear exactly once, so edits are never ambiguous. */
  async editFile(input: string, oldString: string, newString: string) {
    const p = this.path(input, 'write');
    if (!oldString) throw new WorkspaceError('old_string must not be empty; use create_file for new files');
    if (oldString === newString) throw new WorkspaceError('old_string and new_string are identical');
    const current = await this.readFile(p);
    const count = current.split(oldString).length - 1;
    if (count === 0) throw new WorkspaceError(`old_string was not found in "${p}". Read the file again and copy the text exactly, including whitespace`);
    if (count > 1) throw new WorkspaceError(`old_string appears ${count} times in "${p}". Include more surrounding lines so it matches exactly once`);
    await this.write(p, current.replace(oldString, () => newString));
  }

  async createFile(input: string, content: string) {
    const p = this.path(input, 'write');
    if (await this.exists(p)) throw new WorkspaceError(`"${p}" already exists; use edit_file to change it`);
    await this.write(p, content);
  }

  async deleteFile(input: string) {
    const p = this.path(input, 'write');
    const o = await this.overlay.get(p);
    if (o?.op === 'create') return this.overlay.remove(p);
    const base = await this.baseEntry(p);
    if (!base || base.type !== 'blob' || o?.op === 'delete') throw new WorkspaceError(`"${p}" does not exist`);
    await this.overlay.put({ path: p, op: 'delete', baseBlobSha: base.sha, content: null });
  }

  private async write(p: string, content: string) {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new WorkspaceError('files are limited to 1 MB');
    const base = await this.baseEntry(p);
    if (base?.type === 'tree') throw new WorkspaceError(`"${p}" is a directory`);
    if (base) {
      // Writing a file back to its base content drops it from the change set.
      if ((await this.readBase(p)) === content) return this.overlay.remove(p);
      return this.overlay.put({ path: p, op: 'modify', baseBlobSha: base.sha, content });
    }
    await this.overlay.put({ path: p, op: 'create', baseBlobSha: null, content });
  }

  /**
   * Regex search. It runs locally over at most 400 text files / 8 MB under `path` (base plus edits).
   * Beyond that it falls back to GitHub code search, which only covers the default branch.
   */
  async grep(pattern: string, input = '', opts: { glob?: string } = {}): Promise<{ matches: string[]; truncated: boolean; source: 'local' | 'github' }> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'm');
    } catch {
      throw new WorkspaceError(`invalid regular expression: ${pattern}`);
    }
    const dir = this.path(input || this.policy.scope, 'read');
    const files = await this.filesUnder(dir, opts.glob);
    const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
    if (files.length > GREP_MAX_FILES || total > GREP_MAX_BYTES) {
      const paths = (await this.reader.search(pattern.replace(/[\\^$.*+?()[\]{}|]/g, ' ').trim(), dir || undefined)).filter((p) => isWithin(p, this.policy.scope));
      return { matches: paths.map((p) => `${p}: (match on the default branch; open the file to see it)`), truncated: false, source: 'github' };
    }
    const matches: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = await this.readFile(f.path);
      } catch {
        continue; // binary or too large
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          matches.push(`${f.path}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
          if (matches.length >= GREP_MAX_RESULTS) return { matches, truncated: true, source: 'local' };
        }
      }
    }
    return { matches, truncated: false, source: 'local' };
  }

  private async filesUnder(dir: string, glob?: string) {
    const { entries } = await this.reader.tree();
    const overlay = await this.overlay.list();
    const deleted = new Set(overlay.filter((o) => o.op === 'delete').map((o) => o.path));
    const files = new Map<string, { path: string; size?: number }>();
    for (const e of entries) if (e.type === 'blob' && isWithin(e.path, dir) && !deleted.has(e.path)) files.set(e.path, { path: e.path, size: e.size });
    for (const o of overlay) if (o.op !== 'delete' && isWithin(o.path, dir)) files.set(o.path, { path: o.path, size: Buffer.byteLength(o.content ?? '') });
    const match = glob ? globToRegExp(glob) : null;
    return [...files.values()].filter((f) => !match || match.test(f.path.split('/').pop()!) || match.test(f.path));
  }

  async changes(): Promise<FileChange[]> {
    return (await this.overlay.list()).map((o) => ({ path: o.path, op: o.op })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** True if the agent changed the builder's test configuration (needs the user's consent in A-5). */
  async touchesBuilderConfig() {
    return (await this.changes()).some((c) => isBuilderConfig(c.path));
  }

  /** Unified diff of every change against the base commit (what the builder applies with git apply). */
  async patch(): Promise<string> {
    const parts: string[] = [];
    for (const o of await this.overlay.list().then((l) => l.sort((a, b) => a.path.localeCompare(b.path)))) {
      const before = o.op === 'create' ? '' : await this.readBase(o.path);
      const after = o.op === 'delete' ? '' : (o.content ?? '');
      const from = o.op === 'create' ? '/dev/null' : `a/${o.path}`;
      const to = o.op === 'delete' ? '/dev/null' : `b/${o.path}`;
      const body = createTwoFilesPatch(from, to, before, after, undefined, undefined, { context: 3 })
        .split('\n')
        .slice(1) // drop the "Index:/===" header line jsdiff adds
        .filter((l) => !l.startsWith('====='))
        .join('\n');
      const header = `diff --git a/${o.path} b/${o.path}\n${o.op === 'create' ? 'new file mode 100644\n' : o.op === 'delete' ? 'deleted file mode 100644\n' : ''}`;
      parts.push(header + body);
    }
    return parts.join('');
  }

  /** Base and current content of one changed file, for the diff view. */
  async fileVersions(input: string): Promise<{ before: string; after: string }> {
    const p = this.path(input, 'read');
    const o = await this.overlay.get(p);
    if (!o) throw new WorkspaceError(`"${p}" has no changes`);
    return { before: o.op === 'create' ? '' : await this.readBase(p), after: o.op === 'delete' ? '' : (o.content ?? '') };
  }
}

function isDirectChild(path: string, dir: string) {
  if (!dir) return !path.includes('/');
  return path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/');
}

function globToRegExp(glob: string) {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${src}$`);
}
