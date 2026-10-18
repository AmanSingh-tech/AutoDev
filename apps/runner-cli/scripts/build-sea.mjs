// Packages autodev-runner as a single executable with Node's built-in SEA support.
// Needs Node >= 20 (run it on each target OS, or in CI per platform: macOS, Linux, Windows).
//   pnpm --filter @autodev/runner-cli build && pnpm --filter @autodev/runner-cli build:binary
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`Single-binary builds need Node 20+ (this is ${process.version}). The npm package (dist/cli.js) works on Node 18.`);
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const exe = join(out, process.platform === 'win32' ? 'autodev.exe' : 'autodev');
// SEA needs a single CommonJS file.
execFileSync('npx', ['tsup', 'src/cli.ts', '--format', 'cjs', '--target', 'node20', '--out-dir', 'dist/sea', '--no-splitting', '--noExternal', '.*'], { cwd: root, stdio: 'inherit' });
writeFileSync(join(out, 'sea-config.json'), JSON.stringify({ main: join(out, 'sea', 'cli.cjs'), output: join(out, 'sea-prep.blob'), disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', join(out, 'sea-config.json')], { stdio: 'inherit' });
copyFileSync(process.execPath, exe);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe]);
execFileSync('npx', ['postject', exe, 'NODE_SEA_BLOB', join(out, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])], { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);
console.log(`Built ${exe}`);
