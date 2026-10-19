// Builds autodev-runner as a single executable with Node's built-in SEA support.
// SEA embeds the app in the Node binary that runs this script, so each target is built on its own
// OS and CPU (CI does that with a runner per target; see .github/workflows/release-runner.yml).
//
//   node scripts/build-sea.mjs [--version 1.2.3]
//   → dist/bin/autodev-runner-<os>-<arch>[.exe]    os: linux | macos | windows, arch: x64 | arm64
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(
    `Single-binary builds need Node 20+ (this is ${process.version}). The npm package works on Node 18.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const version = args.includes('--version') ? args[args.indexOf('--version') + 1] : '0.1.0';
const OS = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];
if (!OS || !['x64', 'arm64'].includes(process.arch))
  throw new Error(`Unsupported build host ${process.platform}-${process.arch}`);
export const target = `${OS}-${process.arch}`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'sea');
const exe = join(root, 'dist', 'bin', `autodev-runner-${target}${OS === 'windows' ? '.exe' : ''}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(dirname(exe), { recursive: true });

// 1. One CommonJS file with every dependency inside (SEA can't load node_modules).
await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: join(out, 'autodev-runner.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  define: { __AUTODEV_VERSION__: JSON.stringify(version) },
  // ssh2 (used by dockerode for ssh:// Docker hosts) loads these native add-ons only if present.
  external: ['cpu-features', '*.node'],
  logLevel: 'warning',
});

// 2. The SEA blob, then a copy of this Node binary with the blob injected.
const blob = join(out, 'sea-prep.blob');
writeFileSync(
  join(out, 'sea-config.json'),
  JSON.stringify({
    main: join(out, 'autodev-runner.cjs'),
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', join(out, 'sea-config.json')], {
  stdio: 'inherit',
});
copyFileSync(process.execPath, exe);
if (OS === 'macos') execFileSync('codesign', ['--remove-signature', exe]);
const postject = join(root, 'node_modules', '.bin', OS === 'windows' ? 'postject.cmd' : 'postject');
execFileSync(
  postject,
  [
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(OS === 'macos' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit', shell: OS === 'windows' },
);
// An ad-hoc signature so macOS runs it locally; the release workflow re-signs and notarizes it.
if (OS === 'macos') execFileSync('codesign', ['--sign', '-', exe]);

// 3. Smoke test: the binary must start and report the version it was built with.
const reported = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
if (reported !== version) throw new Error(`${exe} reports ${reported}, expected ${version}`);
console.log(`Built ${exe} (${version})`);
