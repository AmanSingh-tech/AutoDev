// Self-hosts Monaco: copies its prebuilt AMD bundle to public/monaco/vs so the editor never loads from a CDN.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const src = join(dirname(require.resolve('monaco-editor/package.json')), 'min', 'vs');
const dest = join(here, '..', 'public', 'monaco', 'vs');
if (!existsSync(src)) throw new Error(`monaco-editor build not found at ${src}`);
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('monaco copied to public/monaco/vs');
