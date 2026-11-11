import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { MAX_AGENT_FILES, MAX_AGENT_FILES_BYTES, MAX_AGENT_TEXT, type AgentOffer, type AgentResult } from '@autodev/protocol';
import { checkOut, type Checkout } from './job-runner';

/**
 * Agent jobs: one phase of a task (plan, design, code, fix) done by the Claude Code that is
 * already installed and signed in on this machine. AutoDev never sees that sign-in: the runner
 * only starts the `claude` command, in a throwaway worktree, with no command-running tools.
 */
export interface ClaudeCode {
  path: string;
  version: string;
}

export type AgentEventFn = (e: { kind: 'text' | 'tool'; toolName?: string; text: string }) => void;

const READ_TOOLS = 'Read,Glob,Grep';
const EDIT_TOOLS = `${READ_TOOLS},Edit,Write`;
const MAX_FILE_BYTES = 1024 * 1024;
const EVENT_CHARS = 4000;

/** `AUTODEV_CLAUDE_PATH`, then `claude` on the PATH, then the usual install locations. */
export async function detectClaudeCode(candidates?: string[]): Promise<ClaudeCode | null> {
  const list = candidates ?? [process.env.AUTODEV_CLAUDE_PATH, 'claude', join(homedir(), '.local', 'bin', 'claude'), join(homedir(), '.claude', 'local', 'claude')].filter((c): c is string => !!c);
  for (const path of list) {
    const version = await versionOf(path);
    if (version) return { path, version };
  }
  return null;
}

function versionOf(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], env: claudeEnv() });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', () => (clearTimeout(timer), resolve(null)));
      child.on('close', (code) => {
        clearTimeout(timer);
        const m = /(\d+\.\d+\.\d+)/.exec(out);
        resolve(code === 0 && m && /claude/i.test(out) ? m[1]! : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** What Claude Code needs to find its own sign-in and reach the network. Nothing else is passed on. */
export function claudeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']);
  const env: Record<string, string> = { AUTODEV: '1' };
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    // The person's own Claude Code configuration (sign-in, provider, model) applies as they set it.
    if (keep.has(k) || k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_USE_') || k === 'CLAUDE_CONFIG_DIR') env[k] = v;
  }
  return env;
}

export function claudeArgs(offer: Pick<AgentOffer, 'allowEdits' | 'system'>): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // No command-running tools, no user/project settings or hooks, file tools confined to the worktree.
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    offer.allowEdits ? EDIT_TOOLS : READ_TOOLS,
    '--permission-mode',
    offer.allowEdits ? 'acceptEdits' : 'manual',
    // Nobody is there to answer a prompt: anything that would ask is denied.
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    '--append-system-prompt',
    offer.system,
  ];
}

interface StreamResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  api_error_status?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export interface ClaudeRun {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: string | null;
  result: StreamResult | null;
  model: string | null;
  lastText: string;
  stderr: string;
}

/** Runs `claude -p` with the prompt on stdin, reading its stream-json output line by line. */
export function runClaude(opts: { path: string; args: string[]; prompt: string; cwd: string; timeoutMs: number; signal: AbortSignal; onEvent: AgentEventFn }): Promise<ClaudeRun> {
  return new Promise((resolve) => {
    const run: ClaudeRun = { exitCode: null, timedOut: false, cancelled: false, spawnError: null, result: null, model: null, lastText: '', stderr: '' };
    const isWin = process.platform === 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.path, opts.args, { cwd: opts.cwd, env: claudeEnv(), detached: !isWin, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      run.spawnError = (e as Error).message;
      return resolve(run);
    }
    const kill = () => {
      try {
        if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => ((run.timedOut = true), kill()), opts.timeoutMs);
    const onAbort = () => ((run.cancelled = true), kill());
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleLine(line, run, opts.cwd, opts.onEvent);
      }
    });
    child.stderr!.on('data', (d: Buffer) => (run.stderr = (run.stderr + d.toString()).slice(-4000)));
    child.on('error', (e) => (run.spawnError = e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      if (buf.trim()) handleLine(buf.trim(), run, opts.cwd, opts.onEvent);
      run.exitCode = code;
      resolve(run);
    });
    child.stdin!.on('error', () => {
      /* the process exited before reading the prompt; 'close' reports it */
    });
    child.stdin!.end(opts.prompt);
  });
}

function handleLine(line: string, run: ClaudeRun, cwd: string, onEvent: AgentEventFn) {
  let msg: { type?: string; subtype?: string; model?: string; message?: { content?: unknown } } & StreamResult;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'system' && msg.subtype === 'init') run.model = msg.model ?? null;
  else if (msg.type === 'result') run.result = msg;
  else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content as { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (block.type === 'text' && block.text?.trim()) {
        run.lastText = block.text;
        onEvent({ kind: 'text', text: block.text.slice(0, EVENT_CHARS) });
      } else if (block.type === 'tool_use' && block.name) {
        onEvent({ kind: 'tool', toolName: block.name, text: describeTool(block.input ?? {}, cwd).slice(0, EVENT_CHARS) });
      }
    }
  }
}

/** "src/app.ts" for a file tool, the pattern for a search. Paths are shown relative to the repo. */
function describeTool(input: Record<string, unknown>, cwd: string): string {
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
  const rel = path ? relative(cwd, path) || '.' : null;
  const pattern = typeof input.pattern === 'string' ? input.pattern : null;
  return [pattern, rel].filter(Boolean).join(' in ') || '';
}

export function classifyError(run: ClaudeRun): { kind: NonNullable<AgentResult['errorKind']>; message: string } {
  if (run.spawnError) return { kind: 'not_installed', message: `Claude Code could not be started on the builder: ${run.spawnError}` };
  const text = `${run.result?.result ?? ''}\n${run.stderr}`;
  if (/not logged in|please run \/login|\/login|invalid api key|authentication_error|oauth token|unauthorized|401/i.test(text)) {
    return { kind: 'not_signed_in', message: 'Claude Code on the builder is not signed in. Run `claude` there once and sign in.' };
  }
  if (run.result?.api_error_status === 429 || /usage limit|rate limit|limit reached|out of (extra )?usage|quota/i.test(text)) {
    return { kind: 'usage_limit', message: `Claude Code reached its usage limit: ${firstLine(run.result?.result ?? run.stderr)}` };
  }
  return { kind: 'other', message: firstLine(run.result?.result || run.stderr || `Claude Code exited with code ${run.exitCode}`) };
}

const firstLine = (s: string) => (s.trim().split('\n')[0] ?? '').slice(0, 500);

/** Every text file that differs from the base commit afterwards. Throws on binary or oversized changes. */
export async function changedFiles(checkout: Checkout, baseSha: string): Promise<AgentResult['files']> {
  await checkout.git.raw(['add', '-A']);
  const raw = await checkout.git.raw(['diff', '--cached', '--name-status', '--no-renames', '-z', baseSha]);
  const parts = raw.split('\0').filter(Boolean);
  const files: AgentResult['files'] = [];
  let total = 0;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const path = parts[i + 1]!;
    if (status.startsWith('D')) {
      files.push({ path, content: null });
      continue;
    }
    const abs = join(checkout.worktree, path);
    const stat = lstatSync(abs);
    if (!stat.isFile()) throw new FileProblem(`"${path}" is not a regular file`);
    if (stat.size > MAX_FILE_BYTES) throw new FileProblem(`"${path}" is larger than 1 MB`);
    const buf = readFileSync(abs);
    if (buf.includes(0)) throw new FileProblem(`"${path}" is a binary file`);
    total += buf.length;
    if (total > MAX_AGENT_FILES_BYTES || files.length >= MAX_AGENT_FILES) throw new FileProblem('the change is too large to send back');
    files.push({ path, content: buf.toString('utf8') });
  }
  return files;
}

export class FileProblem extends Error {}

/** One agent job, start to finish. Never throws: every outcome is an agent.result. */
export class ClaudeCodeRunner {
  constructor(private readonly opts: { cacheDir: string; claude: ClaudeCode; /** Tests only. */ timeoutMsOverride?: number }) {}

  async run(offer: AgentOffer, onEvent: AgentEventFn, signal: AbortSignal): Promise<AgentResult> {
    const started = Date.now();
    const base = { type: 'agent.result' as const, jobId: offer.jobId, text: '', files: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, turns: 0, model: null as string | null };
    const fail = (errorKind: NonNullable<AgentResult['errorKind']>, error: string, status: AgentResult['status'] = 'error', extra: Partial<AgentResult> = {}): AgentResult => ({ ...base, ...extra, status, error: error.slice(0, 2000), errorKind, durationMs: Date.now() - started });

    if (createHash('sha256').update(offer.patch).digest('hex') !== offer.patchSha256) return fail('other', 'patch checksum mismatch');
    if (!existsSync(this.opts.claude.path) && this.opts.claude.path.includes('/')) return fail('not_installed', 'Claude Code is no longer installed on the builder.');

    let checkout: Checkout | null = null;
    try {
      checkout = await checkOut(this.opts.cacheDir, offer, (m) => onEvent({ kind: 'text', text: m.trim() }));
      const run = await runClaude({
        path: this.opts.claude.path,
        args: claudeArgs(offer),
        prompt: offer.prompt,
        cwd: checkout.worktree,
        timeoutMs: this.opts.timeoutMsOverride ?? offer.timeoutMin * 60_000,
        signal,
        onEvent,
      });
      const u = run.result?.usage ?? {};
      const measured: Partial<AgentResult> = {
        usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 },
        turns: run.result?.num_turns ?? 0,
        model: run.model,
      };
      if (run.cancelled) return fail('other', 'cancelled', 'cancelled', measured);
      if (run.timedOut) return fail('other', `Claude Code did not finish within ${offer.timeoutMin} minutes`, 'timed_out', measured);
      if (run.spawnError || run.exitCode !== 0 || !run.result || run.result.is_error) {
        const { kind, message } = classifyError(run);
        return fail(kind, message, 'error', measured);
      }
      const text = (run.result.result || run.lastText).slice(0, MAX_AGENT_TEXT);
      const files = offer.allowEdits ? await changedFiles(checkout, offer.baseSha) : [];
      return { ...base, ...measured, status: 'done', text, files, durationMs: Date.now() - started } as AgentResult;
    } catch (e) {
      if (e instanceof FileProblem) return fail('too_large', `Claude Code's change can't be used: ${e.message}.`);
      return fail('other', e instanceof Error ? e.message : String(e));
    } finally {
      await checkout?.cleanup();
    }
  }
}
