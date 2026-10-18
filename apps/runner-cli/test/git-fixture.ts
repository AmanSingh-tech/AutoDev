import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobOffer } from '@autodev/protocol';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

/** A bare "origin", a developer clone of it, and a patch made with git diff. */
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'autodev-runner-'));
  const work = join(root, 'seed');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'app.txt'), 'hi\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'base');
  const baseSha = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'src', 'app.txt'), 'hello\n');
  const patch = git(work, 'diff') + '\n';
  git(work, 'checkout', '-q', '--', '.');
  const origin = join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', work, origin);
  git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const clone = join(root, 'dev-clone');
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'remote', 'set-url', 'origin', 'git@github.com:acme/web.git');
  git(clone, 'config', `url.${origin}.insteadOf`, 'git@github.com:acme/web.git');
  return { root, origin, clone, baseSha, patch, cache: join(root, 'cache') };
}

export function offer(f: ReturnType<typeof fixture>, over: Partial<JobOffer> = {}): JobOffer {
  const patch = over.patch ?? f.patch;
  return {
    type: 'job.offer',
    jobId: '018f0000-0000-7000-8000-000000000001',
    taskKey: 'AD-1',
    repo: { fullName: 'acme/web', cloneUrl: `file://${f.origin}`, localPath: f.clone },
    baseSha: f.baseSha,
    patch,
    patchSha256: createHash('sha256').update(patch).digest('hex'),
    config: { setup: ['echo installing'], test: ['grep -q hello src/app.txt && echo "1 passed"'], timeout_min: 1 },
    docker: false,
    dockerImage: 'alpine:3.20',
    limits: { cpus: 1, memoryMb: 256, timeoutMin: 1, networkInSetupOnly: true },
    ...over,
  };
}
