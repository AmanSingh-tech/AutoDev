import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.fixture', 'acme-web');

/**
 * A real git repo standing in for acme-demo/web: the mock GitHub serves its tree and blobs, and
 * the builder uses it as its bound clone, so patches apply to a real commit.
 */
export default function globalSetup() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(join(FIXTURE_DIR, 'src'), { recursive: true });
  writeFileSync(join(FIXTURE_DIR, 'README.md'), '# Demo\nRun `pnpm test`.\n');
  writeFileSync(join(FIXTURE_DIR, 'src', 'app.ts'), 'export const greet = () => "hi";\n');
  writeFileSync(join(FIXTURE_DIR, '.autodev.yml'), 'docker_image: alpine:3.20\ntest: grep -q hello src/app.ts && echo "1 passed"\ntimeout_min: 5\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@test', '-c', 'user.name=e2e', ...args], { cwd: FIXTURE_DIR, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('remote', 'add', 'origin', 'git@github.com:acme-demo/web.git');
  // The builder runs the real CLI bundle.
  execFileSync('pnpm', ['--filter', '@autodev/runner-cli', 'build'], { stdio: 'pipe' });
}
