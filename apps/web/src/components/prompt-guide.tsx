'use client';

import type { RouterOutputs } from '@/lib/trpc';
import { Alert, Button } from '@autodev/ui';

export type PromptReview = RouterOutputs['promptGuide']['review'];

const KIND_LABEL: Record<PromptReview['issues'][number]['kind'], string> = {
  missing: 'Missing',
  ambiguous: 'Unclear',
  scope: 'Scope',
  risk: 'Risk',
};

/** Shows the prompt guide's review of the draft above. Nothing changes until the author applies the rewrite. */
export function PromptGuidePanel({
  canReview,
  busy,
  error,
  review,
  onReview,
  onApply,
  onDismiss,
}: {
  canReview: boolean;
  busy: boolean;
  error: string | null;
  review: PromptReview | null;
  onReview: () => void;
  onApply: (rewrite: PromptReview['rewrite']) => void;
  onDismiss: () => void;
}) {
  return (
    <section aria-label="Prompt guide" className="grid gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Prompt guide</p>
          <p className="text-xs text-muted-foreground">
            Checks the draft for what the agent needs. Costs AI usage, like a run.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onReview} disabled={!canReview || busy}>
          {busy ? 'Reviewing…' : review ? 'Review again' : 'Review prompt'}
        </Button>
      </div>

      {error && <Alert tone="destructive">{error}</Alert>}

      {review && (
        <div className="space-y-3 text-sm">
          <p>{review.summary}</p>
          {review.issues.length > 0 && (
            <ul className="space-y-1">
              {review.issues.map((issue, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">
                    {KIND_LABEL[issue.kind]}
                  </span>
                  <span>{issue.text}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="rounded-md bg-muted/50 p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Suggested rewrite</p>
            <p className="font-medium">{review.rewrite.title}</p>
            <p className="mt-2 whitespace-pre-wrap text-xs">{review.rewrite.descriptionMd}</p>
            <p className="mt-2 whitespace-pre-wrap text-xs">
              {review.rewrite.acceptanceCriteriaMd}
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => onApply(review.rewrite)}>
              Use this rewrite
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
