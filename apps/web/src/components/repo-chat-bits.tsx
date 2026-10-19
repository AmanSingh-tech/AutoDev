'use client';

import type { Citation } from '@autodev/db/schema';
import { Button } from '@autodev/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TaskFormValues } from './task-form';

const PREFILL_KEY = 'autodev:task-prefill';

const range = (c: Citation) => (c.startLine ? (c.endLine && c.endLine !== c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`) : '');
/** GitHub link to the cited lines at the commit the answer read (so it doesn't drift as the branch moves). */
export const citationUrl = (htmlUrl: string, sha: string, c: Citation) =>
  `${htmlUrl}/blob/${sha}/${c.path}${c.startLine ? `#L${c.startLine}${c.endLine && c.endLine !== c.startLine ? `-L${c.endLine}` : ''}` : ''}`;
export const citationLabel = (c: Citation) => (range(c) ? `${c.path}:${range(c)}` : c.path);
/** `services/billing/…/ReconciliationServiceImpl.kt:12-40`: the start and the file name survive. */
const middle = (s: string, max = 56) => (s.length <= max ? s : `${s.slice(0, 18)}…${s.slice(-(max - 19))}`);

/** Sources shown before "Show more": enough to check the main claims without a wall of chips. */
const FIRST_SOURCES = 5;

/** The places an answer relied on, as links to GitHub. */
export function Citations({ htmlUrl, sha, citations }: { htmlUrl: string; sha: string | null; citations: Citation[] }) {
  const [all, setAll] = useState(false);
  if (!sha || citations.length === 0) return null;
  const shown = all ? citations : citations.slice(0, FIRST_SOURCES);
  const hidden = citations.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Sources">
      <span>Sources:</span>
      {shown.map((c) => (
        <a
          key={citationLabel(c)}
          href={citationUrl(htmlUrl, sha, c)}
          target="_blank"
          rel="noopener noreferrer"
          title={citationLabel(c)}
          aria-label={citationLabel(c)}
          className="max-w-full truncate rounded border px-1.5 py-0.5 font-mono hover:underline"
        >
          {middle(citationLabel(c))}
        </a>
      ))}
      {hidden > 0 && (
        <button type="button" className="rounded px-1.5 py-0.5 underline-offset-2 hover:underline" onClick={() => setAll(true)}>
          {hidden} more
        </button>
      )}
    </div>
  );
}

/**
 * "Make this a task": opens the new-task form pre-filled with the message and its sources. Nothing
 * is created until the author saves. The hand-off goes through sessionStorage, not the URL, so long
 * answers fit and nothing lands in browser history.
 */
export function MakeTaskButton({
  slug,
  repoName,
  htmlUrl,
  text,
  sha,
  citations = [],
}: {
  slug: string;
  repoName: string;
  htmlUrl: string;
  text: string;
  sha?: string | null;
  citations?: Citation[];
}) {
  const router = useRouter();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={() => {
        const firstLine = text.split('\n').find((l) => l.trim())?.replace(/^[#>*\-\s]+/, '').trim() ?? '';
        const refs = sha && citations.length ? `\n\n## References\n${citations.map((c) => `- [${citationLabel(c)}](${citationUrl(htmlUrl, sha, c)})`).join('\n')}` : '';
        const prefill: Partial<TaskFormValues> = { title: firstLine.slice(0, 120), descriptionMd: `${text.trim()}${refs}`.slice(0, 20_000) };
        try {
          sessionStorage.setItem(PREFILL_KEY, JSON.stringify(prefill));
        } catch {
          // Storage blocked: the form opens empty, which is still useful.
        }
        router.push(`/o/${slug}/repos/${repoName}/new?from=chat`);
      }}
    >
      Make this a task
    </Button>
  );
}

/** Reads and clears the hand-off from MakeTaskButton. */
export function takeTaskPrefill(): Partial<TaskFormValues> | null {
  try {
    const raw = sessionStorage.getItem(PREFILL_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PREFILL_KEY);
    const v = JSON.parse(raw) as Partial<TaskFormValues>;
    return { title: String(v.title ?? '').slice(0, 200), descriptionMd: String(v.descriptionMd ?? '') };
  } catch {
    return null;
  }
}
