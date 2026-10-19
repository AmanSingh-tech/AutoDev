'use client';

import type { Citation } from '@autodev/db/schema';
import { Button } from '@autodev/ui';
import { useRouter } from 'next/navigation';
import type { TaskFormValues } from './task-form';

const PREFILL_KEY = 'autodev:task-prefill';

const range = (c: Citation) => (c.startLine ? (c.endLine && c.endLine !== c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`) : '');
/** GitHub link to the cited lines at the commit the answer read (so it doesn't drift as the branch moves). */
export const citationUrl = (htmlUrl: string, sha: string, c: Citation) =>
  `${htmlUrl}/blob/${sha}/${c.path}${c.startLine ? `#L${c.startLine}${c.endLine && c.endLine !== c.startLine ? `-L${c.endLine}` : ''}` : ''}`;
export const citationLabel = (c: Citation) => (range(c) ? `${c.path}:${range(c)}` : c.path);

/** The places an answer relied on, as links to GitHub. */
export function Citations({ htmlUrl, sha, citations }: { htmlUrl: string; sha: string | null; citations: Citation[] }) {
  if (!sha || citations.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label="Sources">
      <span>Sources:</span>
      {citations.map((c) => (
        <a
          key={citationLabel(c)}
          href={citationUrl(htmlUrl, sha, c)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border px-1.5 py-0.5 font-mono hover:underline"
        >
          {citationLabel(c)}
        </a>
      ))}
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
