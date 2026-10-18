import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFailedTests, steps, type JobOffer, type JobResult } from '@autodev/protocol';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { Executor } from './executors';

export type LogFn = (step: 'system' | 'setup' | 'build' | 'test', stream: 'stdout' | 'stderr' | 'system', data: string) => void;

const TAIL_CHARS = 30_000;

/**
 * Runs one job: get the base commit, make a throwaway worktree, apply the patch, run exactly the
 * base branch's .autodev.yml commands, and always clean up. The developer's own checkout is
 * never touched: worktrees live in a temp directory.
 */
export class JobRunner {
  constructor(private readonly opts: { cacheDir: string; executorFor: (offer: JobOffer) => Executor; /** Tests only. */ timeoutMsOverride?: number }) {}

  async run(offer: JobOffer, log: LogFn, signal: AbortSignal): Promise<JobResult> {
    const started = Date.now();
    const sys = (msg: string) => log('system', 'system', msg.endsWith('\n') ? msg : `${msg}\n`);
    const result = (r: Omit<JobResult, 'type' | 'jobId' | 'durationMs'>): JobResult => ({ type: 'job.result', jobId: offer.jobId, durationMs: Date.now() - started, ...r });

    if (createHash('sha256').update(offer.patch).digest('hex') !== offer.patchSha256) {
      return result({ status: 'error', step: 'system', exitCode: null, failedTests: [], logTail: '', error: 'patch checksum mismatch' });
    }

    let repo: SimpleGit | null = null;
    let worktree: string | null = null;
    const scratch = mkdtempSync(join(tmpdir(), 'autodev-job-'));
    try {
      sys(`AutoDev job for ${offer.taskKey} (${offer.repo.fullName} @ ${offer.baseSha.slice(0, 12)})`);
      repo = await this.repository(offer, sys);
      if (!(await hasCommit(repo, offer.baseSha))) {
        sys('Fetching the base commit…');
        await repo.fetch(['origin', offer.baseSha, '--depth=1', '--no-tags']).catch(async () => repo!.fetch(['origin', '--no-tags']));
      }
      worktree = join(scratch, 'worktree');
      await repo.raw(['worktree', 'add', '--detach', worktree, offer.baseSha]);
      if (offer.patch.trim()) {
        const patchFile = join(scratch, 'change.patch');
        writeFileSync(patchFile, offer.patch);
        await simpleGit(worktree).raw(['apply', '--whitespace=nowarn', patchFile]);
        sys('Applied the patch.');
      }

      const executor = this.opts.executorFor(offer);
      await executor.prepare(sys);
      sys(executor.kind === 'docker' ? `Running in Docker (${offer.dockerImage}), ${offer.limits.cpus} CPUs, ${offer.limits.memoryMb} MB.` : 'Running directly on this machine (no Docker).');
      const deadline = started + (this.opts.timeoutMsOverride ?? offer.limits.timeoutMin * 60_000);

      let tail = '';
      for (const { step, commands } of steps(offer.config)) {
        tail = '';
        for (const command of commands) {
          if (signal.aborted) return result({ status: 'error', step, exitCode: null, failedTests: [], logTail: tail, error: 'cancelled' });
          log(step, 'system', `$ ${command}\n`);
          const res = await executor.run({
            command,
            cwd: worktree,
            network: step === 'setup' || !offer.limits.networkInSetupOnly,
            timeoutMs: Math.max(1000, deadline - Date.now()),
            limits: offer.limits,
            signal,
            onOutput: (stream, data) => {
              tail = (tail + data).slice(-TAIL_CHARS);
              log(step, stream, data);
            },
          });
          if (res.cancelled) return result({ status: 'error', step, exitCode: null, failedTests: [], logTail: tail, error: 'cancelled' });
          if (res.timedOut) return result({ status: 'timed_out', step, exitCode: null, failedTests: parseFailedTests(tail), logTail: tail, error: `exceeded ${offer.limits.timeoutMin} minutes` });
          if (res.exitCode !== 0) return result({ status: 'failed', step, exitCode: res.exitCode, failedTests: step === 'test' ? parseFailedTests(tail) : [], logTail: tail });
        }
      }
      return result({ status: 'passed', step: 'test', exitCode: 0, failedTests: [], logTail: tail });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sys(`Error: ${msg}`);
      return result({ status: 'error', step: 'system', exitCode: null, failedTests: [], logTail: msg.slice(-TAIL_CHARS), error: msg.slice(0, 500) });
    } finally {
      if (repo && worktree) await repo.raw(['worktree', 'remove', '--force', worktree]).catch(() => {});
      await repo?.raw(['worktree', 'prune']).catch(() => {});
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** The developer's bound clone if it really is this repo; otherwise a cached clone of our own. */
  private async repository(offer: JobOffer, sys: (m: string) => void): Promise<SimpleGit> {
    if (offer.repo.localPath && existsSync(join(offer.repo.localPath, '.git'))) {
      const git = simpleGit(offer.repo.localPath);
      // The configured URL, not `get-url`, which applies insteadOf rewrites.
      const remote = (await git.raw(['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
      if (sameRepo(remote, offer.repo.fullName)) {
        sys(`Using your clone at ${offer.repo.localPath} (a separate worktree; your checkout isn't touched).`);
        return git;
      }
      sys(`${offer.repo.localPath} is not a clone of ${offer.repo.fullName}; using a cached clone instead.`);
    }
    const dir = join(this.opts.cacheDir, 'repos', offer.repo.fullName.replace('/', '__'));
    if (!existsSync(join(dir, '.git'))) {
      sys(`Cloning ${offer.repo.fullName} (with your own git credentials)…`);
      mkdirSync(dir, { recursive: true });
      await simpleGit(dir).clone(offer.repo.cloneUrl, dir, ['--no-checkout', '--filter=blob:none']);
    }
    return simpleGit(dir);
  }
}

async function hasCommit(git: SimpleGit, sha: string) {
  try {
    await git.raw(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Matches https/ssh remotes like git@github.com:acme/web.git against "acme/web". */
export function sameRepo(remote: string, fullName: string) {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return !!m && m[1]!.toLowerCase() === fullName.toLowerCase();
}

/** Batches log output into chunks (≤ 60 KB, flushed every 250 ms) so the socket isn't flooded. */
export class LogBatcher {
  private buf: { step: Parameters<LogFn>[0]; stream: Parameters<LogFn>[1]; data: string }[] = [];
  private size = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly flushTo: (chunk: { seq: number; step: Parameters<LogFn>[0]; stream: Parameters<LogFn>[1]; data: string }) => void) {}

  push: LogFn = (step, stream, data) => {
    const last = this.buf.at(-1);
    if (last && last.step === step && last.stream === stream) last.data += data;
    else this.buf.push({ step, stream, data });
    this.size += data.length;
    if (this.size > 60_000) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 250);
  };

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const b of this.buf) {
      for (let i = 0; i < b.data.length; i += 60_000) this.flushTo({ seq: this.seq++, step: b.step, stream: b.stream, data: b.data.slice(i, i + 60_000) });
    }
    this.buf = [];
    this.size = 0;
  }
}
