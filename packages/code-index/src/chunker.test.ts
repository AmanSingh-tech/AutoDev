import { describe, expect, it } from 'vitest';
import { chunkFile, MAX_CHUNK_CHARS, MAX_CHUNK_LINES } from './chunker';

const body = (n: number) => Array.from({ length: n }, (_, i) => `  const v${i} = ${i};`).join('\n');

/** Every line of the file is in some chunk, and chunks are in order. */
function expectCovers(chunks: { startLine: number; endLine: number }[], lines: number) {
  expect(chunks[0]!.startLine).toBe(1);
  expect(chunks[chunks.length - 1]!.endLine).toBe(lines);
  for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.startLine).toBeLessThanOrEqual(chunks[i - 1]!.endLine + 1);
}

describe('chunkFile', () => {
  it('splits TypeScript along functions and classes, naming each', async () => {
    const src = [
      "import { x } from './x';",
      '',
      '/** Adds. */',
      `export function add(a: number, b: number) {\n${body(18)}\n  return a + b;\n}`,
      '',
      `export class Store {\n  get(key: string) {\n${body(30)}\n  }\n\n  set(key: string) {\n${body(30)}\n  }\n}`,
      '',
      `export const parse = (s: string) => {\n${body(18)}\n};`,
    ].join('\n');
    const chunks = await chunkFile('src/store.ts', src);
    expect(chunks.map((c) => c.symbol)).toEqual(['add', 'Store.get', 'Store.set', 'parse']);
    expect(chunks[0]!.content).toContain('/** Adds. */');
    expect(chunks.every((c) => c.language === 'typescript')).toBe(true);
    expectCovers(chunks, src.split('\n').length);
  });

  it('merges small neighbours into one chunk', async () => {
    const src = 'def a():\n    return 1\n\ndef b():\n    return 2\n\nX = 3\n';
    const chunks = await chunkFile('m.py', src);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 7, symbol: 'a' });
  });

  it('parses each supported language', async () => {
    const files: Record<string, string> = {
      'a.go': `package a\n\nfunc Serve() {\n${body(90).replace(/const /g, '')}\n}\n`,
      'A.java': `class A {\n  void run() {\n${body(90).replace(/const /g, 'int ')}\n  }\n}\n`,
      'a.rs': `fn handle() {\n${body(90).replace(/const /g, 'let ')}\n}\n`,
      'a.rb': `class Thing\n  def call\n${body(90).replace(/const /g, '')}\n  end\nend\n`,
      'A.cs': `class A {\n  void Run() {\n${body(90).replace(/const /g, 'var ')}\n  }\n}\n`,
      'a.js': `function main() {\n${body(90)}\n}\n`,
    };
    const want: Record<string, string> = { 'a.go': 'Serve', 'A.java': 'A.run', 'a.rs': 'handle', 'a.rb': 'Thing.call', 'A.cs': 'A.Run', 'a.js': 'main' };
    for (const [path, src] of Object.entries(files)) {
      const chunks = await chunkFile(path, src);
      expect(chunks.some((c) => c.symbol === want[path]), `${path}: ${chunks.map((c) => c.symbol).join(',')}`).toBe(true);
      expectCovers(chunks, src.split('\n').length - 1);
    }
  });

  it('splits functions that are too big into windows that keep the name', async () => {
    const src = `function huge() {\n${body(300)}\n}\n`;
    const chunks = await chunkFile('h.ts', src);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(MAX_CHUNK_LINES);
      expect(c.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    expectCovers(chunks, 302);
  });

  it('splits other text into overlapping windows', async () => {
    const src = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = await chunkFile('docs/guide.md', src);
    expect(chunks.map((c) => c.startLine)).toEqual([1, 33, 65, 97, 129]);
    expect(chunks[1]!.startLine).toBeLessThan(chunks[0]!.endLine);
    expect(chunks.every((c) => c.symbol === null && c.language === 'md')).toBe(true);
    expectCovers(chunks, 150);
  });

  it('keeps chunks under the character limit for very long lines', async () => {
    const src = Array.from({ length: 40 }, () => 'x'.repeat(1000)).join('\n');
    for (const c of await chunkFile('data.txt', src)) expect(c.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('returns nothing for an empty file', async () => {
    expect(await chunkFile('a.ts', '')).toEqual([]);
    expect(await chunkFile('a.md', '\n\n  \n')).toEqual([]);
  });
});
