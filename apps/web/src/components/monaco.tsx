'use client';

import { DiffEditor, Editor, loader } from '@monaco-editor/react';
import { useEffect, useState } from 'react';

// Served by our own app (scripts/copy-monaco.mjs), never a CDN. Absolute URL: Monaco's web
// workers can't resolve a root-relative path. This module only loads in the browser (ssr: false).
loader.config({ paths: { vs: `${window.location.origin}/monaco/vs` } });

function useDarkMode() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

const LANG: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', json: 'json', md: 'markdown', py: 'python', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php', css: 'css', scss: 'scss', html: 'html', yml: 'yaml', yaml: 'yaml', sql: 'sql', sh: 'shell', cs: 'csharp', kt: 'kotlin' };
export const languageOf = (path: string) => LANG[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';

const options = { readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, wordWrap: 'on' as const, renderOverviewRuler: false };

export function MarkdownSource({ value }: { value: string }) {
  const dark = useDarkMode();
  return <Editor height="420px" language="markdown" value={value} theme={dark ? 'vs-dark' : 'vs'} options={options} />;
}

export function FileDiff({ path, before, after }: { path: string; before: string; after: string }) {
  const dark = useDarkMode();
  // Fit small diffs; cap big ones (Monaco scrolls inside).
  const lines = Math.max(before.split('\n').length, after.split('\n').length);
  return (
    <DiffEditor
      height={`${Math.min(560, Math.max(120, lines * 19 + 24))}px`}
      language={languageOf(path)}
      original={before}
      modified={after}
      theme={dark ? 'vs-dark' : 'vs'}
      options={{ ...options, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true }}
    />
  );
}
