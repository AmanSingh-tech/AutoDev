import { describe, expect, it } from 'vitest';
import { MemoryOverlayStore } from './overlay';
import { MemoryRepoReader } from './repo-reader';
import { VirtualWorkspace, WorkspaceError } from './workspace';

const files = {
  'README.md': '# Demo\n',
  'src/app.ts': 'export function login() {\n  return redirect("/");\n}\n',
  'src/util/math.ts': 'export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n',
  'packages/web/index.ts': 'console.log("web");\n',
  '.github/workflows/ci.yml': 'on: push\n',
};

function ws(scope = '') {
  const overlay = new MemoryOverlayStore();
  return { w: new VirtualWorkspace(new MemoryRepoReader(files), overlay, { scope }), overlay };
}

describe('VirtualWorkspace', () => {
  it('lists directories with the overlay merged in', async () => {
    const { w } = ws();
    await w.createFile('src/login.test.ts', 'test');
    await w.deleteFile('src/app.ts');
    expect((await w.listDir('src')).map((e) => `${e.type}:${e.path}`)).toEqual(['dir:src/util', 'file:src/login.test.ts']);
    expect((await w.listDir()).map((e) => e.path)).toEqual(['.github', 'packages', 'src', 'README.md']);
  });

  it('edits by exact, unique string replacement', async () => {
    const { w } = ws();
    await w.editFile('src/app.ts', 'redirect("/")', 'redirect(returnTo ?? "/")');
    expect(await w.readFile('src/app.ts')).toContain('redirect(returnTo ?? "/")');
    await expect(w.editFile('src/app.ts', 'nope', 'x')).rejects.toThrow(/not found/);
    await expect(w.editFile('src/util/math.ts', 'a: number, b: number', 'x')).rejects.toThrow(/appears 2 times/);
  });

  it('drops a file from the change set when it is edited back to its base content', async () => {
    const { w } = ws();
    await w.editFile('README.md', '# Demo', '# Changed');
    await w.editFile('README.md', '# Changed', '# Demo');
    expect(await w.changes()).toEqual([]);
  });

  it('refuses to create over an existing file or delete a missing one', async () => {
    const { w } = ws();
    await expect(w.createFile('README.md', 'x')).rejects.toThrow(/already exists/);
    await expect(w.deleteFile('missing.ts')).rejects.toThrow(/does not exist/);
    await w.createFile('new.ts', 'a');
    await w.deleteFile('new.ts');
    expect(await w.changes()).toEqual([]);
  });

  it('blocks path traversal, .git and workflow files', async () => {
    const { w } = ws();
    for (const bad of ['../secrets', '/etc/passwd', 'src/../../x', '.git/config', 'a\\b']) {
      await expect(w.readFile(bad)).rejects.toBeInstanceOf(WorkspaceError);
    }
    await expect(w.editFile('.github/workflows/ci.yml', 'push', 'pull_request')).rejects.toThrow(/workflow/);
    expect(await w.readFile('.github/workflows/ci.yml')).toBe('on: push\n');
  });

  it('confines reads, edits, listings and search to scope_path', async () => {
    const { w } = ws('packages/web');
    expect((await w.listDir()).map((e) => e.path)).toEqual(['packages/web/index.ts']);
    await expect(w.readFile('src/app.ts')).rejects.toThrow(/outside this task's folder/);
    await expect(w.createFile('src/x.ts', '')).rejects.toThrow(/outside/);
    await expect(w.grep('login', 'src')).rejects.toThrow(/outside/);
    expect((await w.grep('console')).matches).toEqual(['packages/web/index.ts:1: console.log("web");']);
  });

  it('greps base files and edits together', async () => {
    const { w } = ws();
    await w.createFile('src/new.ts', 'export const login2 = 1;\n');
    const res = await w.grep('login', 'src');
    expect(res).toMatchObject({ source: 'local', truncated: false });
    expect(res.matches).toEqual(['src/app.ts:1: export function login() {', 'src/new.ts:1: export const login2 = 1;']);
    expect((await w.grep('add', '', { glob: '*.ts' })).matches).toHaveLength(1);
    await expect(w.grep('(', '')).rejects.toThrow(/invalid regular expression/);
  });

  it('produces a git-applicable unified diff', async () => {
    const { w } = ws();
    await w.editFile('src/app.ts', 'redirect("/")', 'redirect(returnTo)');
    await w.createFile('src/new.ts', 'x\n');
    await w.deleteFile('README.md');
    const patch = await w.patch();
    expect(patch).toContain('diff --git a/README.md b/README.md\ndeleted file mode 100644\n--- a/README.md\n+++ /dev/null');
    expect(patch).toContain('diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts');
    expect(patch).toContain('-  return redirect("/");\n+  return redirect(returnTo);');
  });

  it('flags changes to the builder config', async () => {
    const { w } = ws();
    expect(await w.touchesBuilderConfig()).toBe(false);
    await w.createFile('.autodev.yml', 'test: rm -rf /');
    expect(await w.touchesBuilderConfig()).toBe(true);
  });
});

describe('patch with real git', () => {
  it('applies cleanly with git apply', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'autodev-patch-'));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
    git('init', '-q');

    const { w } = ws();
    await w.editFile('src/app.ts', 'redirect("/")', 'redirect(returnTo)');
    await w.createFile('src/deep/new.ts', 'export {};\n');
    await w.deleteFile('README.md');
    writeFileSync(join(dir, 'change.patch'), await w.patch());
    git('apply', '--check', 'change.patch');
    git('apply', 'change.patch');
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toContain('redirect(returnTo)');
    expect(readFileSync(join(dir, 'src/deep/new.ts'), 'utf8')).toBe('export {};\n');
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
  });
});
