'use client';

import { PROMPT_FLAG_TEXT, scoreBand, scorePrompt, type PromptDraft, type PromptFlag } from '@autodev/protocol/prompt-check';
import { Alert, Button, cn } from '@autodev/ui';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

const BAND_CLASS = {
  good: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  fair: 'border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  weak: 'border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-400',
} as const;

/** The 0–100 prompt score, colored by band. Used in the form and on the task page. */
export function PromptScoreBadge({ score, className }: { score: number; className?: string }) {
  const band = scoreBand(score);
  return (
    <span
      className={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium tabular-nums', BAND_CLASS[band], className)}
      title={`Prompt score ${score} of 100 (${band})`}
    >
      {score}/100
    </span>
  );
}

export const FlagList = ({ flags, className }: { flags: readonly PromptFlag[]; className?: string }) =>
  flags.length === 0 ? null : (
    <ul className={cn('space-y-1 text-sm', className)}>
      {flags.map((f) => (
        <li key={f} className="flex gap-2">
          <span aria-hidden className="text-muted-foreground">
            •
          </span>
          <span>{PROMPT_FLAG_TEXT[f]}</span>
        </li>
      ))}
    </ul>
  );

export interface Rewrite {
  title: string;
  descriptionMd: string;
  acceptanceCriteriaMd: string;
}

/**
 * The prompt guide under the task form. The score updates on every keystroke from fixed rules (no
 * cost). "Check deeper" and "Rewrite" call the model and use the org's AI budget.
 */
export function PromptGuidePanel({
  repoId,
  draft,
  onRewrite,
}: {
  repoId: string;
  draft: PromptDraft;
  /** Apply the rewrite to the form; the form offers Undo (in a toast). */
  onRewrite: (rw: Rewrite) => void;
}) {
  const live = scorePrompt(draft);
  const input = {
    repoId,
    title: draft.title,
    descriptionMd: draft.descriptionMd,
    acceptanceCriteriaMd: draft.acceptanceCriteriaMd,
    extraContext: draft.extraContext || undefined,
    scopePath: draft.scopePath || undefined,
  };
  const draftKey = JSON.stringify(input);
  const check = trpc.promptGuide.check.useMutation();
  const rewrite = trpc.promptGuide.rewrite.useMutation({ onSuccess: (rw) => onRewrite(rw) });
  // A deeper check is only shown for the draft it looked at.
  const [checkedKey, setCheckedKey] = useState('');
  const deep = check.data && checkedKey === draftKey ? check.data : null;
  const canCall = draft.title.trim().length > 0;
  const error = check.error?.message ?? rewrite.error?.message ?? null;

  return (
    <section aria-label="Prompt guide" className="grid gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">Prompt score</p>
          <PromptScoreBadge score={live.score} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canCall || check.isPending}
            onClick={() => {
              setCheckedKey(draftKey);
              check.mutate(input);
            }}
          >
            {check.isPending ? 'Checking…' : 'Check deeper'}
          </Button>
          <Button type="button" size="sm" disabled={!canCall || rewrite.isPending} onClick={() => rewrite.mutate(input)} aria-busy={rewrite.isPending}>
            {rewrite.isPending ? 'Rewriting…' : 'Rewrite'}
          </Button>
        </div>
      </div>

      {live.flags.length > 0 ? (
        <FlagList flags={live.flags} />
      ) : (
        <p className="text-sm text-muted-foreground">Nothing obvious is missing.</p>
      )}
      <p className="text-xs text-muted-foreground">
        The score comes from fixed rules and is saved with the task. Check deeper and Rewrite use AI, which counts toward
        your budget. A rewrite marks unknowns as [TODO: …] for you to fill in.
      </p>

      {error && <Alert tone="destructive">{error}</Alert>}

      {deep && (
        <div className="animate-enter space-y-2 rounded-md bg-muted/50 p-3 text-sm motion-reduce:animate-fade" aria-label="Deeper check">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">AI check</span>
            <PromptScoreBadge score={deep.score} />
          </div>
          <p>{deep.summary}</p>
          {deep.suggestions.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {deep.suggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
