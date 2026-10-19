// Prepares the npm package `autodev-runner` in dist/npm (the release workflow publishes it).
//   node scripts/pack-npm.mjs --version 1.2.3
// The workspace code (@autodev/protocol, zod, yaml) is bundled; the three runtime dependencies are
// installed by npm as usual.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const version = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/pack-npm.mjs --version <semver>');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'npm');
const tsup = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsup.cmd' : 'tsup');
execFileSync(tsup, [], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, AUTODEV_VERSION: version },
  shell: process.platform === 'win32',
});

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(root, 'dist', 'cli.js'), join(out, 'cli.js'));
copyFileSync(join(root, 'README.md'), join(out, 'README.md'));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtime = Object.fromEntries(
  Object.entries(pkg.dependencies).filter(([name]) => !name.startsWith('@autodev/')),
);
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'autodev-runner',
      version,
      description:
        'Runs AutoDev test jobs on your machine: pairs with your org, picks up jobs automatically, and runs only the commands in .autodev.yml.',
      type: 'module',
      bin: { autodev: 'cli.js', 'autodev-runner': 'cli.js' },
      files: ['cli.js', 'README.md'],
      engines: { node: '>=18.18' },
      dependencies: runtime,
      license: 'UNLICENSED',
    },
    null,
    2,
  ) + '\n',
);
console.log(`Prepared autodev-runner@${version} in ${out}`);
