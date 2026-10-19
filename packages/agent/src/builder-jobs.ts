import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { AgentJob } from '@autodev/config';
import { and, asc, desc, eq, inArray, isNull, schema, sql, transitionTask, type SystemDb } from '@autodev/db';
import type { KvCache } from '@autodev/github';
import { DEFAULT_DOCKER_IMAGE, MAX_PATCH_BYTES, parseAutodevConfig, type AutodevConfig, type GatewayMessage, type JobResult } from '@autodev/protocol';
import type { BlobStore } from '@autodev/storage';
import type { VirtualWorkspace } from './workspace';

const { builderJobs, builderRepoBindings, builders, notifications, orgs, repos, tasks } = schema;

export type BuilderJob = typeof builderJobs.$inferSelect;

export const presenceKey = (builderId: string) => `builder:presence:${builderId}`;
export const busyKey = (builderId: string) => `builder:busy:${builderId}`;

/** Delivers a message to whichever gateway instance holds the builder's socket (Redis pub/sub). */
export interface BuilderBus {
  send(builderId: string, msg: GatewayMessage): Promise<void>;
}

export const builderChannel = (builderId: string) => `builder:${builderId}`;
export const liveLogsKey = (jobId: string) => `job:logs:${jobId}`;

/** A BuilderBus over any Redis-like publish (ioredis `publish`). */
export const publishBus = (publish: (channel: string, message: string) => Promise<unknown>): BuilderBus => ({
  send: async (builderId, msg) => void (await publish(builderChannel(builderId), JSON.stringify(msg))),
});

const DEFAULT_LIMITS = { cpus: 2, memoryMb: 4096, networkInSetupOnly: true };
const builderActor = { type: 'builder' as const, userId: null };

/**
 * Builder jobs: created when the agent wants tests run, dispatched to an online builder, and
 * completed by the gateway. Every state change is a guarded UPDATE, so retries and races are safe.
 */
export class BuilderJobs {
  constructor(
    private readonly deps: {
      sys: SystemDb;
      cache: KvCache;
      blobs: BlobStore;
      bus: BuilderBus;
      enqueueAgent: (job: AgentJob, jobId: string) => Promise<unknown>;
    },
  ) {}

  /** Snapshot the patch and the BASE branch's .autodev.yml for a test run. */
  async create(input: {
    task: typeof tasks.$inferSelect;
    agentRunId: string;
    workspace: VirtualWorkspace;
    rootView: VirtualWorkspace;
    baseSha: string;
    revision: number;
    final: boolean;
    fixCycle: number;
  }): Promise<BuilderJob> {
    const { task } = input;
    const patch = await input.workspace.patch();
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error('The change is larger than 10 MB and cannot be sent to a builder');
    const source = await input.rootView.readBaseFile('.autodev.yml').then((s) => s ?? input.rootView.readBaseFile('.autodev.yaml'));
    const parsed = source === null ? null : parseAutodevConfig(source);
    const configChanged = await input.workspace.touchesBuilderConfig();
    const jobId = uuidv7();
    const patchHash = await this.deps.blobs.put(patch);

    const [job] = await this.deps.sys
      .insert(builderJobs)
      .values({
        id: jobId,
        orgId: task.orgId,
        taskId: task.id,
        agentRunId: input.agentRunId,
        repoId: task.repoId,
        requestedBy: task.ownerId,
        baseSha: input.baseSha,
        workspaceRevision: input.revision,
        patchHash,
        patchSha256: createHash('sha256').update(patch).digest('hex'),
        configSnapshot: parsed?.ok ? (parsed.config as unknown as Record<string, unknown>) : null,
        configError: parsed && !parsed.ok ? parsed.error : null,
        configChanged,
        consent: configChanged ? 'pending' : 'not_needed',
        final: input.final,
        fixCycle: input.fixCycle,
        // No (valid) .autodev.yml on the base branch: there is nothing we're allowed to run.
        status: parsed?.ok ? 'queued' : 'skipped',
        finishedAt: parsed?.ok ? null : new Date(),
      })
      .returning();
    if (configChanged) {
      await this.notify(task.orgId, task.ownerId, 'job.consent_needed', `${task.key} changes .autodev.yml`, 'Review the new test commands and allow the run before your builder executes anything.', task.key);
    }
    return job!;
  }

  /** Try to hand a queued job to an online builder. Returns the builder used, or null if it stays queued. */
  async dispatch(jobId: string): Promise<string | null> {
    const { sys } = this.deps;
    const [job] = await sys.select().from(builderJobs).where(eq(builderJobs.id, jobId));
    if (!job || job.status !== 'queued' || job.consent === 'pending' || job.consent === 'denied') return null;
    const [task] = await sys.select().from(tasks).where(eq(tasks.id, job.taskId));
    if (!task || task.status !== 'waiting_for_builder') return null;

    for (const b of await this.candidates(job)) {
      // One job at a time per builder: claim it, then claim the job.
      if (!(await this.deps.cache.setIfAbsent(busyKey(b.id), job.id, 45 * 60))) continue;
      const [claimed] = await sys
        .update(builderJobs)
        .set({ status: 'offered', builderId: b.id, offeredAt: new Date(), docker: b.kind === 'team' ? true : job.docker })
        .where(and(eq(builderJobs.id, job.id), eq(builderJobs.status, 'queued')))
        .returning();
      if (!claimed) {
        await this.deps.cache.del(busyKey(b.id));
        return null;
      }
      await this.deps.bus.send(b.id, await this.offer(claimed, b));
      return b.id;
    }

    if (!job.offlineNotifiedAt) {
      const [first] = await sys.update(builderJobs).set({ offlineNotifiedAt: new Date() }).where(and(eq(builderJobs.id, job.id), isNull(builderJobs.offlineNotifiedAt))).returning();
      if (first) await this.notify(task.orgId, task.ownerId, 'job.queued_offline', `${task.key} is waiting for your builder`, 'Start it with `autodev start`. Queued tests run as soon as it connects.', task.key);
    }
    return null;
  }

  /**
   * Builders that may run this job right now: the owner's own online builders (bound ones first,
   * then the rest), then shared team builders (Docker only). Unconfirmed first runs are skipped.
   */
  private async candidates(job: BuilderJob) {
    const { sys, cache } = this.deps;
    const rows = await sys
      .select({ b: builders, binding: builderRepoBindings })
      .from(builders)
      .leftJoin(builderRepoBindings, and(eq(builderRepoBindings.builderId, builders.id), eq(builderRepoBindings.repoId, job.repoId)))
      .where(and(eq(builders.orgId, job.orgId), isNull(builders.revokedAt), sql`(${builders.ownerUserId} = ${job.requestedBy} or (${builders.kind} = 'team' and ${builders.allowShared} and ${builders.dockerAvailable}))`));
    const online: { b: (typeof rows)[number]['b']; rank: number }[] = [];
    for (const { b, binding } of rows) {
      if ((await cache.get(presenceKey(b.id))) === null) continue;
      if (!binding?.firstRunConfirmedAt) continue;
      if (job.docker && !b.dockerAvailable && b.kind === 'personal') continue;
      online.push({ b, rank: (b.ownerUserId === job.requestedBy ? 0 : 2) + (binding.localPath ? 0 : 1) });
    }
    return online.sort((x, y) => x.rank - y.rank).map((x) => x.b);
  }

  /** Called when a builder connects: offer it the oldest job it may run, if any. */
  async dispatchFor(builderId: string): Promise<string | null> {
    const { sys } = this.deps;
    const [b] = await sys.select().from(builders).where(eq(builders.id, builderId));
    if (!b || b.revokedAt) return null;
    const queued = await sys
      .select({ id: builderJobs.id })
      .from(builderJobs)
      .where(and(eq(builderJobs.orgId, b.orgId), eq(builderJobs.status, 'queued'), b.kind === 'team' && b.allowShared ? undefined : eq(builderJobs.requestedBy, b.ownerUserId)))
      .orderBy(asc(builderJobs.queuedAt))
      .limit(20);
    for (const j of queued) {
      const used = await this.dispatch(j.id);
      if (used === builderId) return j.id;
      if (used) continue;
    }
    return null;
  }

  private async offer(job: BuilderJob, b: typeof builders.$inferSelect): Promise<GatewayMessage> {
    const [repo] = await this.deps.sys.select().from(repos).where(eq(repos.id, job.repoId));
    const [binding] = await this.deps.sys.select().from(builderRepoBindings).where(and(eq(builderRepoBindings.builderId, b.id), eq(builderRepoBindings.repoId, job.repoId)));
    const [task] = await this.deps.sys.select({ key: tasks.key }).from(tasks).where(eq(tasks.id, job.taskId));
    const config = job.configSnapshot as unknown as AutodevConfig;
    const patch = (await this.deps.blobs.get(job.patchHash))?.toString('utf8') ?? '';
    return {
      type: 'job.offer',
      jobId: job.id,
      taskKey: task!.key,
      repo: { fullName: repo!.fullName, cloneUrl: `https://github.com/${repo!.fullName}.git`, localPath: binding?.localPath ?? null },
      baseSha: job.baseSha,
      patch,
      patchSha256: job.patchSha256,
      config,
      docker: job.docker || b.kind === 'team',
      dockerImage: config.docker_image ?? DEFAULT_DOCKER_IMAGE,
      limits: { ...DEFAULT_LIMITS, cpus: Math.min(DEFAULT_LIMITS.cpus, b.maxCpus), memoryMb: Math.min(DEFAULT_LIMITS.memoryMb, b.maxMemoryMb), timeoutMin: config.timeout_min },
    };
  }

  // ---- called by the gateway ----

  async accepted(builderId: string, jobId: string) {
    const { sys } = this.deps;
    const [job] = await sys
      .update(builderJobs)
      .set({ status: 'running', startedAt: new Date(), attempts: sql`${builderJobs.attempts} + 1` })
      .where(and(eq(builderJobs.id, jobId), eq(builderJobs.builderId, builderId), eq(builderJobs.status, 'offered')))
      .returning();
    if (!job) return null;
    const [task] = await sys.select().from(tasks).where(eq(tasks.id, job.taskId));
    if (task?.status === 'waiting_for_builder') await transitionTask(sys, task, 'testing', builderActor, { jobId, builderId });
    return job;
  }

  /** Rejected or timed-out offer: free the builder and try the next one. */
  async released(builderId: string, jobId: string, reason: string) {
    const [job] = await this.deps.sys
      .update(builderJobs)
      .set({ status: 'queued', builderId: null, offeredAt: null, error: reason })
      .where(and(eq(builderJobs.id, jobId), eq(builderJobs.builderId, builderId), eq(builderJobs.status, 'offered')))
      .returning();
    await this.deps.cache.del(busyKey(builderId));
    if (job) await this.dispatch(job.id);
  }

  async finished(builderId: string, r: JobResult, logHash: string | null) {
    const { sys } = this.deps;
    const [job] = await sys
      .update(builderJobs)
      .set({
        status: r.status === 'passed' ? 'passed' : r.status === 'timed_out' ? 'timed_out' : r.status === 'error' ? 'error' : 'failed',
        exitCode: r.exitCode,
        failedStep: r.step,
        failedTests: r.failedTests,
        durationMs: r.durationMs,
        logTail: r.logTail,
        logHash,
        error: r.error ?? null,
        finishedAt: new Date(),
      })
      .where(and(eq(builderJobs.id, r.jobId), eq(builderJobs.builderId, builderId), eq(builderJobs.status, 'running')))
      .returning();
    await this.deps.cache.del(busyKey(builderId));
    if (!job) return null;
    await this.deps.enqueueAgent({ kind: 'run', orgId: job.orgId, taskId: job.taskId }, `job-${job.id}`);
    // The builder is free again: give it the next queued job.
    await this.dispatchFor(builderId);
    return job;
  }

  /** A builder disconnected: re-queue what it was running and put the task back to waiting. */
  async disconnected(builderId: string) {
    const { sys } = this.deps;
    const jobs = await sys
      .update(builderJobs)
      .set({ status: 'queued', builderId: null, offeredAt: null, startedAt: null, error: 'builder disconnected' })
      .where(and(eq(builderJobs.builderId, builderId), inArray(builderJobs.status, ['offered', 'running'])))
      .returning();
    await this.deps.cache.del(busyKey(builderId));
    for (const job of jobs) {
      const [task] = await sys.select().from(tasks).where(eq(tasks.id, job.taskId));
      if (task?.status === 'testing') await transitionTask(sys, task, 'waiting_for_builder', builderActor, { reason: 'builder_disconnected' }).catch(() => {});
      await this.dispatch(job.id);
    }
  }

  async cancelForTask(taskId: string) {
    const jobs = await this.deps.sys
      .update(builderJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(builderJobs.taskId, taskId), inArray(builderJobs.status, ['queued', 'offered', 'running'])))
      .returning();
    for (const j of jobs) if (j.builderId) await this.deps.bus.send(j.builderId, { type: 'job.cancel', jobId: j.id });
  }

  async latestForRun(runId: string) {
    const [job] = await this.deps.sys.select().from(builderJobs).where(eq(builderJobs.agentRunId, runId)).orderBy(desc(builderJobs.queuedAt)).limit(1);
    return job ?? null;
  }

  async maxFixCycles(orgId: string) {
    const [o] = await this.deps.sys.select({ n: orgs.maxFixCycles }).from(orgs).where(eq(orgs.id, orgId));
    return o?.n ?? 3;
  }

  private async notify(orgId: string, userId: string, type: string, title: string, body: string, key: string) {
    await this.deps.sys.insert(notifications).values({ orgId, userId, type, title, body, link: `/tasks/${key}` });
  }
}
