import { describe, expect, it, vi } from 'vitest';
import { createRepoSyncProcessor } from './repo-sync';

describe('repo-sync processor', () => {
  it('rejects malformed job data before touching GitHub', async () => {
    const clientFor = vi.fn();
    const process = createRepoSyncProcessor({ sys: {} as never, cfg: {} as never, clientFor });
    await expect(process({ data: { kind: 'installation', githubInstallationId: 'nope' } })).rejects.toThrow();
    await expect(process({ data: { kind: 'unknown' } })).rejects.toThrow();
    expect(clientFor).not.toHaveBeenCalled();
  });
});
