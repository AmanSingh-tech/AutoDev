import type { AgentOffer, JobOffer } from '@autodev/protocol';
import { ClaudeCodeRunner, type ClaudeCode } from './claude-code';
import { BuilderConnection } from './connection';
import type { Executor } from './executors';
import { JobRunner, LogBatcher } from './job-runner';

export interface BuilderOptions {
  gatewayUrl: string;
  token: string;
  cliVersion: string;
  cacheDir: string;
  /** null = Docker isn't available (or --no-docker): docker jobs are rejected. */
  dockerExecutor: ((image: string) => Executor) | null;
  shellExecutor: Executor;
  /** null = Claude Code isn't installed here: agent jobs are rejected. */
  claudeCode?: ClaudeCode | null;
  log: (line: string) => void;
}

/** One job at a time. Docker jobs need Docker; without it (or with --no-docker) they're rejected. */
export class Builder {
  private current: { jobId: string; abort: AbortController } | null = null;
  readonly connection: BuilderConnection;
  private readonly runner: JobRunner;
  private readonly agentRunner: ClaudeCodeRunner | null;

  constructor(private readonly opts: BuilderOptions) {
    this.agentRunner = opts.claudeCode ? new ClaudeCodeRunner({ cacheDir: opts.cacheDir, claude: opts.claudeCode }) : null;
    this.runner = new JobRunner({
      cacheDir: opts.cacheDir,
      executorFor: (offer) => (offer.docker ? opts.dockerExecutor!(offer.dockerImage) : opts.shellExecutor),
    });
    this.connection = new BuilderConnection({
      url: opts.gatewayUrl,
      token: opts.token,
      cliVersion: opts.cliVersion,
      dockerAvailable: !!opts.dockerExecutor,
      runningJobId: () => this.current?.jobId ?? null,
      claudeCode: opts.claudeCode?.version ?? null,
      onOffer: (offer) => void this.onOffer(offer),
      onAgentOffer: (offer) => void this.onAgentOffer(offer),
      onCancel: (jobId) => {
        if (this.current?.jobId === jobId) {
          opts.log(`Job ${jobId} cancelled from the dashboard.`);
          this.current.abort.abort();
        }
      },
      onStatus: (s, detail) => opts.log(s === 'online' ? 'Connected. Waiting for jobs…' : `${s}${detail ? `: ${detail}` : ''}`),
    });
  }

  start() {
    this.connection.start();
  }

  stop() {
    this.current?.abort.abort();
    this.connection.stop();
  }

  get busy() {
    return !!this.current;
  }

  private async onOffer(offer: JobOffer) {
    if (this.current) return this.connection.send({ type: 'job.reject', jobId: offer.jobId, reason: 'busy' });
    if (offer.docker && !this.opts.dockerExecutor) {
      return this.connection.send({ type: 'job.reject', jobId: offer.jobId, reason: 'docker_unavailable', message: 'Docker is not available on this builder' });
    }
    const abort = new AbortController();
    this.current = { jobId: offer.jobId, abort };
    this.connection.send({ type: 'job.accept', jobId: offer.jobId });
    this.opts.log(`Running tests for ${offer.taskKey} (${offer.repo.fullName})…`);
    const batcher = new LogBatcher((c) => this.connection.send({ type: 'log.chunk', jobId: offer.jobId, ...c }));
    try {
      const result = await this.runner.run(offer, batcher.push, abort.signal);
      batcher.flush();
      this.connection.send(result);
      this.opts.log(`${offer.taskKey}: ${result.status} in ${Math.round(result.durationMs / 1000)}s`);
    } finally {
      this.current = null;
    }
  }

  /** One phase of a task, done by this machine's own Claude Code. Tests and agent jobs share the one slot. */
  private async onAgentOffer(offer: AgentOffer) {
    if (this.current) return this.connection.send({ type: 'job.reject', jobId: offer.jobId, reason: 'busy' });
    if (!this.agentRunner) return this.connection.send({ type: 'job.reject', jobId: offer.jobId, reason: 'claude_unavailable', message: 'Claude Code is not installed on this builder' });
    const abort = new AbortController();
    this.current = { jobId: offer.jobId, abort };
    this.connection.send({ type: 'job.accept', jobId: offer.jobId });
    this.opts.log(`Claude Code: ${offer.phase} for ${offer.taskKey} (${offer.repo.fullName})…`);
    let seq = 0;
    try {
      const result = await this.agentRunner.run(offer, (e) => this.connection.send({ type: 'agent.event', jobId: offer.jobId, seq: seq++, ...e }), abort.signal);
      this.connection.send(result);
      this.opts.log(`${offer.taskKey}: ${offer.phase} ${result.status}${result.error ? ` (${result.error})` : ''} in ${Math.round(result.durationMs / 1000)}s`);
    } finally {
      this.current = null;
    }
  }
}
