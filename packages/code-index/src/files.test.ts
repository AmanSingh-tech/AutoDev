import { describe, expect, it } from 'vitest';
import { grammarFor, looksBinary, MAX_FILE_BYTES, shouldIndex } from './files';

describe('shouldIndex', () => {
  it('keeps source and text files', () => {
    for (const p of ['src/a.ts', 'README.md', 'cmd/main.go', 'Makefile', 'app/models/user.rb', '.github/workflows/ci.yml']) expect(shouldIndex(p, 100)).toBe(true);
  });
  it('skips vendored and generated folders, lockfiles, binaries, minified and large files', () => {
    for (const p of ['node_modules/x/index.js', 'web/dist/app.js', 'pnpm-lock.yaml', 'go.sum', 'logo.png', 'public/app.min.js', 'font.woff2', 'vendor/lib.go'])
      expect(shouldIndex(p, 100), p).toBe(false);
    expect(shouldIndex('src/big.ts', MAX_FILE_BYTES + 1)).toBe(false);
  });
  it('maps extensions to grammars', () => {
    expect(grammarFor('a/b.tsx')).toBe('tsx');
    expect(grammarFor('x.py')).toBe('python');
    expect(grammarFor('x.cs')).toBe('c_sharp');
    expect(grammarFor('notes.txt')).toBeNull();
  });
  it('spots binary content', () => {
    expect(looksBinary(Buffer.from([0x50, 0x00, 0x01]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
  });
});
