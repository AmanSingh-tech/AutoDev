import { createHash } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentOffer } from '@autodev/protocol';
import { describe, expect, it } from 'vitest';
import { fixture, git } from '../test/git-fixture';
import { claudeArgs, claudeEnv, ClaudeCodeRunner, detectClaudeCode } from './claude-code';

/** A stand-in for the `claude` command: it speaks stream-json and does what the prompt's MODE says. */
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const out = (o) => console.log(JSON.stringify(o));
const mode = (/MODE:(\\w+)/.exec(prompt) || [])[1];
out({ type: 'system', subtype: 'init', model: 'claude-test' });
if (mode === 'sleep') { setTimeout(() => {}, 30000); }
else if (mode === 'login') { out({ type: 'result', subtype: 'error', is_error: true, result: 'Not logged in · Please run /login' }); process.exit(1); }
else {
  if (mode === 'edit') {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: process.cwd() + '/src/app.txt' } }] } });
    fs.writeFileSync('src/app.txt', fs.readFileSync('src/app.txt', 'utf8').trim() + ' world\\n');
    fs.writeFileSync('src/new.txt', 'new\\n');
  }
  if (mode === 'delete') fs.unlinkSync('src/app.txt');
  if (mode === 'binary') fs.writeFileSync('logo.bin', Buffer.from([1, 0, 2]));
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: mode === 'plan' ? '## Approach\\nDo it.' : 'Changed the greeting.', num_turns: 2, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } });
}
`;

function setup(timeoutMsOverride?: number) {
  const f = fixture();
  const path = join(f.root, 'fake-claude');
  writeFileSync(path, FAKE);
  chmodSync(path, 0o755);
  return { f, path, runner: new ClaudeCodeRunner({ cacheDir: f.cache, claude: { path, version: '9.9.9' }, timeoutMsOverride }) };
}

function agentOffer(f: ReturnType<typeof fixture>, mode: string, over: Partial<AgentOffer> = {}): AgentOffer {
  const patch = over.patch ?? '';
  return {
    type: 'agent.offer',
    jobId: '018f0000-0000-7000-8000-000000000002',
    taskKey: 'AD-1',
    repo: { fullName: 'acme/web', cloneUrl: `file://${f.origin}`, localPath: f.clone },
    baseSha: f.baseSha,
    patch,
    patchSha256: createHash('sha256').update(patch).digest('hex'),
    phase: 'plan',
    system: 'rules',
    prompt: `Do the task. MODE:${mode}`,
    allowEdits: false,
    timeoutMin: 1,
    ...over,
  };
}
const never = new AbortController().signal;

describe('Claude Code on the builder', () => {
  it('finds Claude Code and its version, or reports none', async () => {
    const { path } = setup();
    expect(await detectClaudeCode([path])).toEqual({ path, version: '9.9.9' });
    expect(await detectClaudeCode(['/nonexistent/claude'])).toBeNull();
  });

  it('gives read-only tools for plans, edit tools for code, and never a command-running tool', () => {
    const plan = claudeArgs({ allowEdits: false, system: 'S' });
    const code = claudeArgs({ allowEdits: true, system: 'S' });
    expect(plan[plan.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(code[code.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write');
    for (const args of [plan, code]) {
      expect(args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none']));
      expect(args.join(' ')).not.toMatch(/Bash|bypassPermissions/);
    }
  });

  it("passes on the person's Claude settings but none of their other secrets", () => {
    const env = claudeEnv({ PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 's', DATABASE_URL: 'pg' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'k' });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']));
  });

  it('returns the plan text for a read-only phase, with usage, and cleans up the worktree', async () => {
    const { f, runner } = setup();
    const events: string[] = [];
    const res = await runner.run(agentOffer(f, 'plan'), (e) => events.push(`${e.kind}:${e.text}`), never);
    expect(res).toMatchObject({ status: 'done', text: '## Approach\nDo it.', files: [], turns: 2, model: 'claude-test', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1 } });
    expect(events).toContain('text:Working on it.');
    expect(git(f.clone, 'status', '--porcelain')).toBe('');
    expect(git(f.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('starts from the changes so far and returns every file that differs from the base', async () => {
    const { f, runner } = setup();
    const events: { kind: string; toolName?: string; text: string }[] = [];
    // The patch already turned "hi" into "hello"; Claude Code then appends " world" and adds a file.
    const res = await runner.run(agentOffer(f, 'edit', { phase: 'code', allowEdits: true, patch: f.patch }), (e) => events.push(e), never);
    expect(res.status).toBe('done');
    expect(res.text).toBe('Changed the greeting.');
    expect(res.files).toEqual([
      { path: 'src/app.txt', content: 'hello world\n' },
      { path: 'src/new.txt', content: 'new\n' },
    ]);
    expect(events).toContainEqual({ kind: 'tool', toolName: 'Edit', text: 'src/app.txt' });
  });

  it('reports deleted files, and refuses binary changes', async () => {
    const { f, runner } = setup();
    expect((await runner.run(agentOffer(f, 'delete', { phase: 'code', allowEdits: true }), () => {}, never)).files).toEqual([{ path: 'src/app.txt', content: null }]);
    expect(await runner.run(agentOffer(f, 'binary', { phase: 'code', allowEdits: true }), () => {}, never)).toMatchObject({ status: 'error', errorKind: 'too_large', files: [] });
  });

  it('says when Claude Code is not signed in', async () => {
    const { f, runner } = setup();
    expect(await runner.run(agentOffer(f, 'login'), () => {}, never)).toMatchObject({ status: 'error', errorKind: 'not_signed_in' });
  });

  it('can be cancelled, and times out', async () => {
    const { f, runner } = setup();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 400);
    expect(await runner.run(agentOffer(f, 'sleep'), () => {}, abort.signal)).toMatchObject({ status: 'cancelled' });
    const slow = setup(600);
    expect(await slow.runner.run(agentOffer(slow.f, 'sleep'), () => {}, never)).toMatchObject({ status: 'timed_out' });
  });

  it('refuses a patch that does not match its checksum', async () => {
    const { f, runner } = setup();
    expect(await runner.run(agentOffer(f, 'plan', { patchSha256: 'a'.repeat(64) }), () => {}, never)).toMatchObject({ status: 'error', error: 'patch checksum mismatch' });
  });
});
