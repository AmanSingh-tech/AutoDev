import { describe, expect, it, vi } from 'vitest';
import { createCodeIndexProcessor } from './code-index';

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const R1 = '00000000-0000-4000-8000-0000000000a1';
const R2 = '00000000-0000-4000-8000-0000000000a2';

function setup() {
  const indexer = {
    syncRepo: vi.fn(async () => ({ status: 'disabled' as const })),
    reposOf: vi.fn(async (org: string) => (org === ORG ? [R1, R2] : [])),
    enabledOrgs: vi.fn(async () => [ORG, OTHER]),
    purgeOrg: vi.fn(async () => ({ chunks: 3 })),
  };
  const queue = { add: vi.fn(async () => undefined) };
  return { indexer, queue, run: createCodeIndexProcessor({ indexer, queue }) };
}

describe('code-index processor', () => {
  it('indexes one repo', async () => {
    const { indexer, run } = setup();
    await run({ data: { kind: 'repo', orgId: ORG, repoId: R1 } });
    expect(indexer.syncRepo).toHaveBeenCalledWith(ORG, R1);
  });

  it('fans an org out into one repo job per repo, with one job id per repo', async () => {
    const { queue, run } = setup();
    expect(await run({ data: { kind: 'org', orgId: ORG } })).toEqual({ queued: 2 });
    expect(queue.add.mock.calls).toEqual([
      ['repo', { kind: 'repo', orgId: ORG, repoId: R1 }, { jobId: `repo-${R1}` }],
      ['repo', { kind: 'repo', orgId: ORG, repoId: R2 }, { jobId: `repo-${R2}` }],
    ]);
  });

  it('queues every enabled org nightly, and purges', async () => {
    const { indexer, run } = setup();
    expect(await run({ data: { kind: 'nightly' } })).toEqual({ queued: 2 });
    expect(indexer.reposOf).toHaveBeenCalledTimes(2);
    expect(await run({ data: { kind: 'purge', orgId: ORG } })).toEqual({ chunks: 3 });
  });

  it('rejects malformed jobs', async () => {
    const { indexer, run } = setup();
    await expect(run({ data: { kind: 'repo', orgId: 'nope' } })).rejects.toThrow();
    expect(indexer.syncRepo).not.toHaveBeenCalled();
  });
});
