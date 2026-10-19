import { schema, eq, createSystemDb } from '@autodev/db';
import { makeOrg, truncateAll, TEST_SYSTEM_URL } from '@autodev/db/testing';
import { MemoryBlobStore } from '@autodev/storage';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BLOB_GRACE_HOURS, sweepBlobs } from './blob-retention';

const sys = createSystemDb(TEST_SYSTEM_URL);
afterAll(() => sys.close());

const NOW = new Date('2026-10-19T04:00:00Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

let fx: Awaited<ReturnType<typeof makeOrg>>;
let blobs: MemoryBlobStore;
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  blobs = new MemoryBlobStore();
});

/** A finished builder job whose log and patch are stored. Returns the job id and both hashes. */
async function builderJob(finishedDaysAgo: number) {
  const patchHash = await blobs.put(`patch ${Math.random()}`);
  const logHash = await blobs.put(`log ${Math.random()}`);
  const [task] = await sys.db
    .insert(schema.tasks)
    .values({
      orgId: fx.org.id,
      repoId: fx.repo.id,
      number: Math.floor(Math.random() * 1e6),
      key: `AD-${Math.floor(Math.random() * 1e6)}`,
      title: 't',
      mode: 'direct',
      branchMode: 'new',
      workBranch: 'autodev/x',
      ownerId: fx.owner.id,
      status: 'pr_open',
      createPrOnCompletion: false,
      completedAt: daysAgo(finishedDaysAgo),
    })
    .returning();
  const [job] = await sys.db
    .insert(schema.builderJobs)
    .values({
      orgId: fx.org.id,
      taskId: task!.id,
      repoId: fx.repo.id,
      requestedBy: fx.owner.id,
      baseSha: 'b'.repeat(40),
      workspaceRevision: 1,
      patchHash,
      patchSha256: 'c'.repeat(64),
      configSnapshot: {},
      status: 'passed',
      logHash,
      finishedAt: daysAgo(finishedDaysAgo),
    })
    .returning();
  return { taskId: task!.id, jobId: job!.id, patchHash, logHash };
}

/** A run of a task, with a transcript. */
async function run(taskId: string, transcriptHash: string) {
  const [r] = await sys.db
    .insert(schema.agentRuns)
    .values({ orgId: fx.org.id, taskId, phase: 'code', status: 'succeeded', transcriptHash })
    .returning();
  return r!;
}

describe('sweepBlobs', () => {
  it('clears logs past the org retention but keeps patches, and keeps recent logs', async () => {
    await sys.db
      .update(schema.orgs)
      .set({ logRetentionDays: 30 })
      .where(eq(schema.orgs.id, fx.org.id));
    const old = await builderJob(40);
    const recent = await builderJob(10);

    const report = await sweepBlobs({ sys: sys.db, blobs }, NOW);

    expect(report.logsCleared).toBe(1);
    const [oldRow] = await sys.db
      .select()
      .from(schema.builderJobs)
      .where(eq(schema.builderJobs.id, old.jobId));
    const [recentRow] = await sys.db
      .select()
      .from(schema.builderJobs)
      .where(eq(schema.builderJobs.id, recent.jobId));
    expect(oldRow!.logHash).toBeNull();
    expect(oldRow!.patchHash).toBe(old.patchHash);
    expect(recentRow!.logHash).toBe(recent.logHash);
  });

  it('clears transcripts of finished tasks past the snapshot retention', async () => {
    await sys.db
      .update(schema.orgs)
      .set({ snapshotRetentionDays: 14 })
      .where(eq(schema.orgs.id, fx.org.id));
    const old = await builderJob(20);
    const oldTranscript = await blobs.put('old transcript');
    const oldRun = await run(old.taskId, oldTranscript);
    const newer = await builderJob(3);
    const newerTranscript = await blobs.put('newer transcript');
    const newerRun = await run(newer.taskId, newerTranscript);

    const report = await sweepBlobs({ sys: sys.db, blobs }, NOW);

    expect(report.snapshotsCleared).toBe(1);
    expect(
      (await sys.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, oldRun.id)))[0]!
        .transcriptHash,
    ).toBeNull();
    expect(
      (await sys.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, newerRun.id)))[0]!
        .transcriptHash,
    ).toBe(newerTranscript);
  });

  it('deletes unreferenced blobs only after the grace period', async () => {
    const orphanOld = await blobs.put('orphan, old');
    const orphanNew = await blobs.put('orphan, new');
    // The store stamps "now"; move the first one back past the grace period.
    blobs.data.get(orphanOld)!.createdAt = new Date(
      NOW.getTime() - (BLOB_GRACE_HOURS + 1) * 3_600_000,
    );
    blobs.data.get(orphanNew)!.createdAt = new Date(NOW.getTime() - 60_000);

    const report = await sweepBlobs({ sys: sys.db, blobs }, NOW);

    expect(report.blobsDeleted).toBe(1);
    expect(await blobs.get(orphanOld)).toBeNull();
    expect(await blobs.get(orphanNew)).not.toBeNull();
  });

  it('never deletes a blob that a row still points to, however old it is', async () => {
    // Finished 100 days ago, under a 365-day log retention: the log is still within it.
    const job = await builderJob(100);
    blobs.data.get(job.patchHash)!.createdAt = daysAgo(100);
    blobs.data.get(job.logHash)!.createdAt = daysAgo(100);
    await sys.db
      .update(schema.orgs)
      .set({ logRetentionDays: 365 })
      .where(eq(schema.orgs.id, fx.org.id));

    await sweepBlobs({ sys: sys.db, blobs }, NOW);

    expect(await blobs.get(job.patchHash)).not.toBeNull();
    expect(await blobs.get(job.logHash)).not.toBeNull();
  });
});
