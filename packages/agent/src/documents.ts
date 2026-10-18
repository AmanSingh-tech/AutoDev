import type { DocumentKind } from '@autodev/db';

/** Required sections, straight from the spec. A submission missing one is sent back to the agent. */
export const REQUIRED_SECTIONS: Record<DocumentKind, string[]> = {
  plan: ['Approach', 'Files to change', 'Risks', 'Open questions'],
  lld: ['Files and functions', 'Schema and API changes', 'Edge cases', 'Test cases to add'],
};

export function missingSections(kind: DocumentKind, markdown: string): string[] {
  const headings = markdown
    .split('\n')
    .filter((l) => /^#{1,4}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, '').trim().toLowerCase());
  return REQUIRED_SECTIONS[kind].filter((s) => !headings.some((h) => h.startsWith(s.toLowerCase())));
}

/**
 * File paths an approved plan or LLD mentions. Coding is limited to these. Changing anything else
 * is a deviation, and the agent has to ask the user first.
 */
export function mentionedPaths(markdown: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:^|[\s(`'"[])((?:\.?[\w@.-]+\/)*[\w@.-]*\w\.[A-Za-z0-9]{1,10})(?=$|[\s)`'",:;\]]|\.(?:\s|$))/gm;
  for (const m of markdown.matchAll(re)) {
    const p = m[1]!.replace(/^\.\//, '');
    if (!/^\d+(\.\d+)+$/.test(p) && !/^(e\.g|i\.e|etc)\.?$/i.test(p)) out.add(p);
  }
  // Directories written with a trailing slash (`src/auth/`) allow everything under them.
  for (const m of markdown.matchAll(/`((?:[\w@.-]+\/)+)`/g)) out.add(m[1]!);
  return out;
}

export function isAllowedByDesign(path: string, allowed: Set<string>) {
  if (allowed.has(path)) return true;
  for (const a of allowed) if (a.endsWith('/') && path.startsWith(a)) return true;
  return false;
}
