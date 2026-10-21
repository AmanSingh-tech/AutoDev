/** Which files go into the index, and which parser reads them. */

/** Larger files are almost always generated, minified or data. */
export const MAX_FILE_BYTES = 200 * 1024;
/** Files indexed per repo. The rest are counted in `skippedFiles`. */
export const MAX_FILES_PER_REPO = 20_000;

/** Grammars from `tree-sitter-wasms`, by file extension. Other text files are split into line windows. */
const GRAMMARS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  java: 'java',
  rs: 'rust',
  rb: 'ruby',
  cs: 'c_sharp',
};

const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.idea',
  '.vscode',
  'bower_components',
  'Pods',
]);

const SKIP_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'go.sum',
  'packages.lock.json',
]);

/** Binary, media and archive formats. Anything else is checked for NUL bytes after reading. */
const SKIP_EXT = new Set(
  (
    'png jpg jpeg gif webp bmp ico svg tiff psd avif heic mp3 mp4 mov avi wav ogg flac webm ' +
    'woff woff2 ttf otf eot zip gz tgz bz2 xz 7z rar tar jar war ear pdf doc docx xls xlsx ppt pptx ' +
    'exe dll so dylib a o obj class pyc pyo wasm bin dat db sqlite sqlite3 parquet avro pkl npy npz onnx pt ckpt ' +
    'map snap lock'
  ).split(' '),
);

/** Whether a file at `path` of `size` bytes is indexed. */
export function shouldIndex(path: string, size: number | undefined): boolean {
  if (size !== undefined && size > MAX_FILE_BYTES) return false;
  const parts = path.split('/');
  const name = parts[parts.length - 1]!;
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d))) return false;
  if (SKIP_FILES.has(name)) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower.endsWith('.bundle.js')) return false;
  const ext = extOf(lower);
  return !ext || !SKIP_EXT.has(ext);
}

/** The tree-sitter grammar for a path, or null for line windows. */
export function grammarFor(path: string): string | null {
  return GRAMMARS[extOf(path.toLowerCase()) ?? ''] ?? null;
}

/** A short language label stored on each chunk: the grammar, or the file extension. */
export function languageFor(path: string): string | null {
  return grammarFor(path) ?? extOf(path.toLowerCase());
}

/** Text files have no NUL bytes in their first 8 KB. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function extOf(name: string): string | null {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : null;
}
