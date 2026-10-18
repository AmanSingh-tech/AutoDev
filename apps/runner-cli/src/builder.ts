import type { JobOffer } from '@autodev/protocol';
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
  log: (line: string) => void;
}

/** One job at a time. Docker jobs need Docker; without it (or with --no-docker) they're rejected. */
export class Builder {
  private current: { jobId: string; abort: AbortController } | null = null;
  readonly connection: BuilderConnection;
  private readonly runner: JobRunner;

  constructor(private readonly opts: BuilderOptions) {
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
      onOffer: (offer) => void this.onOffer(offer),
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
}
