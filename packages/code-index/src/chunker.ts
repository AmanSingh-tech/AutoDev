import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { grammarFor, languageFor } from './files';

/**
 * Splits a file into chunks for the index. Code in a supported language is split along its syntax
 * (functions, classes, methods), small neighbours are merged, and anything too big is split into
 * line windows. Other text is split into overlapping line windows. Chunks cover every line.
 */

export interface Chunk {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  symbol: string | null;
  language: string | null;
  content: string;
}

/**
 * About 450 tokens at most. The embedding model's cost grows with the square of the length: on
 * a 12-thread laptop CPU a 1,500-character chunk takes about 0.5 s and a 4,000-character one about 4 s
 * (and a batch of those needs gigabytes). Smaller chunks also point search at one thing.
 */
export const MAX_CHUNK_LINES = 50;
export const MAX_CHUNK_CHARS = 1500;
const WINDOW_LINES = 40;
const WINDOW_OVERLAP = 8;

/** A run of lines (0-based, inclusive), with the definition it holds, if any. */
interface Unit {
  start: number;
  end: number;
  symbol: string | null;
}

const require = createRequire(import.meta.url);
let ready: Promise<void> | null = null;
const languages = new Map<string, Promise<Parser.Language>>();

function language(grammar: string) {
  let lang = languages.get(grammar);
  if (!lang) {
    lang = Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`));
    languages.set(grammar, lang);
  }
  return lang;
}

export async function chunkFile(path: string, content: string): Promise<Chunk[]> {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0 || content.trim() === '') return [];
  const lang = languageFor(path);
  const grammar = grammarFor(path);

  let units: Unit[] | null = null;
  if (grammar) {
    try {
      units = await syntaxUnits(grammar, content, lines);
    } catch {
      units = null; // A grammar that fails on a file falls back to windows.
    }
  }
  if (!units) return windows(lines, 0, lines.length - 1, WINDOW_OVERLAP).map((u) => toChunk(u, lines, lang));
  return merge(units, lines).map((u) => toChunk(u, lines, lang));
}

async function syntaxUnits(grammar: string, content: string, lines: string[]): Promise<Unit[]> {
  ready ??= Parser.init();
  await ready;
  const parser = new Parser();
  try {
    parser.setLanguage(await language(grammar));
    const tree = parser.parse(content);
    try {
      return cover(unitsOf(tree.rootNode, lines, null), 0, lines.length - 1);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/** Units for a node: the node itself if it fits, otherwise its children's units, otherwise windows. */
function unitsOf(node: Parser.SyntaxNode, lines: string[], parent: string | null): Unit[] {
  const start = node.startPosition.row;
  const end = Math.min(node.endPosition.row, lines.length - 1);
  const own = symbolOf(node);
  const symbol = own ? (parent ? `${parent}.${own}` : own) : parent;
  // A piece of a definition (its body, a field) carries the enclosing definition's name.
  if (node.parent && fits(start, end, lines)) return [{ start, end, symbol }];

  const children = node.namedChildren.filter((c) => c.endPosition.row >= start);
  if (children.length === 0) return windows(lines, start, end, 0).map((u) => ({ ...u, symbol }));
  // `export class X` and decorated definitions: the inner declaration names itself, so don't prefix it twice.
  const wrapper = node.type === 'export_statement' || node.type === 'decorated_definition';
  const units = children.flatMap((c) => unitsOf(c, lines, own && !wrapper ? symbol : parent));
  // The lines before the first child (a class or function header) belong to the first unit.
  return cover(units, start, end);
}

/** Makes units contiguous over start..end: a gap (comments, decorators, braces) joins the unit after it. */
function cover(units: Unit[], start: number, end: number): Unit[] {
  const out: Unit[] = [];
  let next = start;
  for (const u of [...units].sort((a, b) => a.start - b.start)) {
    if (u.end < next) continue;
    const e = Math.min(u.end, end);
    out.push({ start: next, end: e, symbol: u.symbol });
    next = e + 1;
    if (next > end) break;
  }
  if (out.length === 0) return [{ start, end, symbol: null }];
  out[out.length - 1]!.end = end;
  return out;
}

/** Two small definitions may share a chunk; bigger ones get their own, so search hits point at one thing. */
const SHARED_DEFINITION_LINES = 25;

/** Greedily joins neighbouring units while the result still fits. Units too big are split into windows. */
function merge(units: Unit[], lines: string[]): Unit[] {
  const out: (Unit & { open: boolean })[] = [];
  for (const u of units) {
    if (!fits(u.start, u.end, lines)) {
      for (const w of windows(lines, u.start, u.end, 0)) out.push({ ...w, symbol: u.symbol, open: false });
      continue;
    }
    const prev = out[out.length - 1];
    const both = !!(prev?.symbol && u.symbol);
    // A header of a few lines (`class Store {`) always joins what follows it.
    const header = prev ? prev.end - prev.start + 1 <= 3 : false;
    if (prev?.open && fits(prev.start, u.end, lines) && (!both || header || u.end - prev.start + 1 <= SHARED_DEFINITION_LINES)) {
      // `Store` followed by `Store.get` is named by the more specific one.
      if (prev.symbol && u.symbol?.startsWith(`${prev.symbol}.`)) prev.symbol = u.symbol;
      prev.end = u.end;
      prev.symbol ??= u.symbol;
    } else out.push({ ...u, open: true });
  }
  return out.map(({ start, end, symbol }) => ({ start, end, symbol }));
}

function windows(lines: string[], start: number, end: number, overlap: number): Unit[] {
  const out: Unit[] = [];
  let s = start;
  while (s <= end) {
    let e = Math.min(end, s + WINDOW_LINES - 1);
    // Long lines: shrink the window until it fits the character limit (at least one line).
    while (e > s && charsIn(lines, s, e) > MAX_CHUNK_CHARS) e = s + Math.floor((e - s) / 2);
    out.push({ start: s, end: e, symbol: null });
    if (e >= end) break;
    s = Math.max(s + 1, e + 1 - overlap);
  }
  return out;
}

function fits(start: number, end: number, lines: string[]) {
  return end - start + 1 <= MAX_CHUNK_LINES && charsIn(lines, start, end) <= MAX_CHUNK_CHARS;
}

function charsIn(lines: string[], start: number, end: number) {
  let n = 0;
  for (let i = start; i <= end; i++) n += (lines[i]?.length ?? 0) + 1;
  return n;
}

const DEFINITION = /function|method|class|interface|struct|enum|trait|impl|module|namespace|type_alias|type_declaration|constructor/;

/** The name a definition declares: `name` field, or for `const x = () => …` the variable's name. */
function symbolOf(node: Parser.SyntaxNode): string | null {
  if (!node.isNamed) return null;
  if (DEFINITION.test(node.type)) {
    const name = node.childForFieldName('name') ?? node.childForFieldName('type');
    if (name) return name.text.slice(0, 120);
  }
  if (node.type === 'export_statement' || node.type === 'decorated_definition') {
    const inner = node.childForFieldName('declaration') ?? node.childForFieldName('definition') ?? node.namedChildren.find((c) => DEFINITION.test(c.type) || c.type.includes('declaration'));
    return inner ? symbolOf(inner) : null;
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const decl = node.namedChildren.find((c) => c.type === 'variable_declarator');
    const value = decl?.childForFieldName('value');
    // Functions and classes held in a variable, and any top-level or exported constant.
    const topLevel = node.parent?.type === 'program' || node.parent?.type === 'export_statement';
    const name = decl?.childForFieldName('name');
    // Destructuring (`const { a, b } = …`) declares no single name.
    if (name?.type === 'identifier' && value && (topLevel || /function|arrow|class/.test(value.type))) return name.text.slice(0, 120);
  }
  return null;
}

function toChunk(u: Unit, lines: string[], language: string | null): Chunk {
  return { startLine: u.start + 1, endLine: u.end + 1, symbol: u.symbol, language, content: lines.slice(u.start, u.end + 1).join('\n') };
}
