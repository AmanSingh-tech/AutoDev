import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, git, offer } from '../test/git-fixture';
import { ShellExecutor } from './executors';
import { JobRunner, LogBatcher, sameRepo } from './job-runner';

const shell = new ShellExecutor();
function runner(f: ReturnType<typeof fixture>, timeoutMsOverride?: number) {
  return new JobRunner({ cacheDir: f.cache, executorFor: () => shell, timeoutMsOverride });
}
function collect() {
  const lines: string[] = [];
  return { lines, log: (step: string, _s: string, d: string) => void lines.push(`${step}|${d}`) };
}

describe('JobRunner', () => {
  it("applies the patch in a throwaway worktree, runs the steps, and leaves the developer's clone untouched", async () => {
    const f = fixture();
    const c = collect();
    const res = await runner(f).run(offer(f), c.log, new AbortController().signal);
    expect(res).toMatchObject({ status: 'passed', exitCode: 0, step: 'test' });
    expect(c.lines.join('')).toContain('setup|$ echo installing');
    expect(c.lines.join('')).toContain('1 passed');
    expect(c.lines.join('')).toContain('Using your clone');
    // The clone's own checkout and branch didn't change, and no worktree is left behind.
    expect(git(f.clone, 'status', '--porcelain')).toBe('');
    expect(git(f.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('reports a failing step with its exit code and failing tests', async () => {
    const f = fixture();
    const res = await runner(f).run(offer(f, { config: { test: ["echo ' FAIL  src/a.test.ts > greets'; exit 3"], timeout_min: 1 } }), () => {}, new AbortController().signal);
    expect(res).toMatchObject({ status: 'failed', step: 'test', exitCode: 3, failedTests: [{ file: 'src/a.test.ts', name: 'greets' }] });
    expect(res.logTail).toContain('FAIL');
  });

  it('stops at the first failing step', async () => {
    const f = fixture();
    const res = await runner(f).run(offer(f, { config: { setup: ['exit 1'], test: ['echo never'], timeout_min: 1 } }), () => {}, new AbortController().signal);
    expect(res).toMatchObject({ status: 'failed', step: 'setup' });
  });

  it('times out and kills the whole process tree', async () => {
    const f = fixture();
    const t0 = Date.now();
    const res = await runner(f, 800).run(offer(f, { config: { test: ['sleep 30 & sleep 30; wait'], timeout_min: 1 } }), () => {}, new AbortController().signal);
    expect(res.status).toBe('timed_out');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('can be cancelled', async () => {
    const f = fixture();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const res = await runner(f).run(offer(f, { config: { test: ['sleep 30'], timeout_min: 1 } }), () => {}, abort.signal);
    expect(res).toMatchObject({ status: 'error', error: 'cancelled' });
  });

  it('refuses a patch that does not match its checksum', async () => {
    const f = fixture();
    const o = offer(f);
    const res = await runner(f).run({ ...o, patch: o.patch + '\n+evil' }, () => {}, new AbortController().signal);
    expect(res).toMatchObject({ status: 'error', error: 'patch checksum mismatch' });
  });

  it("does not pass the developer's environment into test commands", async () => {
    const f = fixture();
    process.env.AUTODEV_TEST_SECRET = 'sk-live-xyz';
    try {
      const res = await runner(f).run(offer(f, { config: { test: ['test -z "$AUTODEV_TEST_SECRET" && test "$CI" = true'], timeout_min: 1 } }), () => {}, new AbortController().signal);
      expect(res.status).toBe('passed');
    } finally {
      delete process.env.AUTODEV_TEST_SECRET;
    }
  });

  it('falls back to its own cached clone when there is no bound clone', async () => {
    const f = fixture();
    const c = collect();
    const res = await runner(f).run(offer(f, { repo: { fullName: 'acme/web', cloneUrl: `file://${f.origin}`, localPath: null } }), c.log, new AbortController().signal);
    expect(res.status).toBe('passed');
    expect(existsSync(join(f.cache, 'repos', 'acme__web', '.git'))).toBe(true);
    // Temp worktrees are gone.
    expect(readdirSync(join(f.cache, 'repos')).length).toBe(1);
  });
});

describe('helpers', () => {
  it('matches remotes to repo names', () => {
    expect(sameRepo('git@github.com:Acme/Web.git', 'acme/web')).toBe(true);
    expect(sameRepo('https://github.com/acme/web', 'acme/web')).toBe(true);
    expect(sameRepo('https://github.com/acme/web-other.git', 'acme/web')).toBe(false);
  });

  it('batches log output into ordered chunks', async () => {
    const chunks: { seq: number; data: string }[] = [];
    const b = new LogBatcher((c) => chunks.push(c));
    b.push('test', 'stdout', 'a');
    b.push('test', 'stdout', 'b');
    b.push('test', 'stderr', 'c');
    b.flush();
    expect(chunks.map((c) => [c.seq, c.data])).toEqual([
      [0, 'ab'],
      [1, 'c'],
    ]);
  });
});
