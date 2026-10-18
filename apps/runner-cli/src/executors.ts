import { spawn } from 'node:child_process';
import type Docker from 'dockerode';
import type { Limits } from '@autodev/protocol';

export interface ExecRequest {
  command: string;
  cwd: string;
  /** Allow network access for this command (setup only, by default). */
  network: boolean;
  timeoutMs: number;
  limits: Limits;
  signal: AbortSignal;
  onOutput: (stream: 'stdout' | 'stderr', data: string) => void;
}

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

export interface Executor {
  readonly kind: 'docker' | 'shell';
  prepare(onSystem: (msg: string) => void): Promise<void>;
  run(req: ExecRequest): Promise<ExecResult>;
}

/** Only what builds need; the developer's own environment (API keys, tokens) is never passed in. */
export function safeEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  const env: Record<string, string> = { CI: 'true', AUTODEV: '1' };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/**
 * Runs commands directly on the machine (`autodev start --no-docker`). No isolation: only the
 * builder's own developer should choose this, and team builders never do.
 */
export class ShellExecutor implements Executor {
  readonly kind = 'shell' as const;
  async prepare() {}

  run(req: ExecRequest): Promise<ExecResult> {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const child = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', req.command] : ['-c', req.command], {
        cwd: req.cwd,
        env: safeEnv(),
        detached: !isWin, // own process group, so a timeout kills the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let timedOut = false;
      let cancelled = false;
      const kill = () => {
        try {
          if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => ((timedOut = true), kill()), req.timeoutMs);
      const onAbort = () => ((cancelled = true), kill());
      req.signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf8').on('data', (d: string) => req.onOutput('stdout', d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => req.onOutput('stderr', d));
      child.on('close', (code) => {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        resolve({ exitCode: code, timedOut, cancelled });
      });
      child.on('error', (err) => {
        req.onOutput('stderr', `${err.message}\n`);
      });
    });
  }
}

/**
 * The default: each command runs in a fresh container from the job's image, with the worktree
 * mounted at /workspace, CPU and memory limits, and no network unless the step allows it.
 * Files are written as the developer's own user, so cleanup never needs root.
 */
export class DockerExecutor implements Executor {
  readonly kind = 'docker' as const;
  constructor(
    private readonly docker: Docker,
    private readonly image: string,
  ) {}

  async prepare(onSystem: (msg: string) => void) {
    try {
      await this.docker.getImage(this.image).inspect();
    } catch {
      onSystem(`Pulling ${this.image}…\n`);
      const stream = await this.docker.pull(this.image);
      await new Promise<void>((resolve, reject) => this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())));
    }
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    const user = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid!()}` : undefined;
    const container = await this.docker.createContainer({
      Image: this.image,
      Cmd: ['sh', '-c', req.command],
      WorkingDir: '/workspace',
      Env: ['CI=true', 'AUTODEV=1', 'HOME=/tmp'],
      ...(user ? { User: user } : {}),
      Tty: false,
      HostConfig: {
        Binds: [`${req.cwd}:/workspace`],
        NanoCpus: Math.round(req.limits.cpus * 1e9),
        Memory: req.limits.memoryMb * 1024 * 1024,
        NetworkMode: req.network ? 'bridge' : 'none',
        PidsLimit: 1024,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
    });
    let timedOut = false;
    let cancelled = false;
    const stop = async () => {
      try {
        await container.kill();
      } catch {
        /* already stopped */
      }
    };
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const { PassThrough } = await import('node:stream');
      const out = new PassThrough();
      const err = new PassThrough();
      out.setEncoding('utf8').on('data', (d: string) => req.onOutput('stdout', d));
      err.setEncoding('utf8').on('data', (d: string) => req.onOutput('stderr', d));
      container.modem.demuxStream(stream, out, err);
      await container.start();
      const timer = setTimeout(() => ((timedOut = true), void stop()), req.timeoutMs);
      const onAbort = () => ((cancelled = true), void stop());
      req.signal.addEventListener('abort', onAbort, { once: true });
      const res = (await container.wait()) as { StatusCode: number };
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
      return { exitCode: res.StatusCode, timedOut, cancelled };
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }
}
