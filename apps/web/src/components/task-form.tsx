'use client';

import type { TaskMode, TaskPriority } from '@autodev/db/schema';
import { Alert, Button, Input, Label, NativeSelect } from '@autodev/ui';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { trpc } from '@/lib/trpc';
import { PromptGuidePanel } from './prompt-guide';
import { MODE_LABEL } from './task-bits';

export interface TaskFormValues {
  title: string;
  descriptionMd: string;
  acceptanceCriteriaMd: string;
  priority: TaskPriority;
  mode: TaskMode | '';
  scopePath: string;
  branchMode: 'new' | 'existing';
  targetBranch: string;
  relatedTaskId: string;
  relatedLabel: string;
  extraContext: string;
  createPrOnCompletion: boolean;
}

export const emptyTask = (): TaskFormValues => ({
  title: '',
  descriptionMd: '',
  acceptanceCriteriaMd: '',
  priority: 'medium',
  mode: '',
  scopePath: '',
  branchMode: 'new',
  targetBranch: '',
  relatedTaskId: '',
  relatedLabel: '',
  extraContext: '',
  createPrOnCompletion: true,
});

const textarea =
  'flex min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** Create and edit share this form. The repo's locked mode, if any, disables the mode picker. */
export function TaskForm({
  repo,
  initial,
  submitting,
  error,
  onSubmit,
  actions,
}: {
  repo: { id: string; defaultBranch: string; lockedMode: TaskMode | null; defaultMode: TaskMode | null };
  initial: TaskFormValues;
  submitting: boolean;
  error?: string | null;
  onSubmit: (v: TaskFormValues, start: boolean) => void;
  actions: (submit: (start: boolean) => void) => ReactNode;
}) {
  const [v, setV] = useState(initial);
  const set = <K extends keyof TaskFormValues>(k: K, val: TaskFormValues[K]) => setV({ ...v, [k]: val });
  const review = trpc.promptGuide.review.useMutation();
  const branches = trpc.repos.branches.useQuery({ repoId: repo.id }, { enabled: v.branchMode === 'existing', staleTime: 5 * 60_000 });
  const [relatedQ, setRelatedQ] = useState('');
  const deferredQ = useDeferredValue(relatedQ);
  const related = trpc.tasks.list.useQuery({ q: deferredQ, limit: 8 }, { enabled: deferredQ.trim().length > 0 });
  const submit = (start: boolean) => onSubmit(v, start);

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <Field id="title" label="Title">
        <Input id="title" required maxLength={200} value={v.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Redirect to the original page after login" />
      </Field>
      <Field id="desc" label="Description" hint="What should change and why. Markdown is fine.">
        <textarea id="desc" className={textarea} value={v.descriptionMd} onChange={(e) => set('descriptionMd', e.target.value)} />
      </Field>
      <Field id="ac" label="Acceptance criteria" hint="One per line. The agent checks its work against these, and they go into the PR.">
        <textarea id="ac" className={textarea} value={v.acceptanceCriteriaMd} onChange={(e) => set('acceptanceCriteriaMd', e.target.value)} placeholder={'- Users land on the page they asked for\n- Existing login tests still pass'} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="priority" label="Priority">
          <NativeSelect id="priority" value={v.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)}>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </NativeSelect>
        </Field>
        <Field id="mode" label="Workflow" hint={repo.lockedMode ? 'An admin locked this repository to one workflow.' : undefined}>
          <NativeSelect id="mode" value={repo.lockedMode ?? v.mode} disabled={!!repo.lockedMode} onChange={(e) => set('mode', e.target.value as TaskMode | '')}>
            {!repo.lockedMode && <option value="">Default{repo.defaultMode ? ` (${MODE_LABEL[repo.defaultMode]})` : ''}</option>}
            {(Object.keys(MODE_LABEL) as TaskMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <fieldset className="grid gap-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Branch</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="branchMode" checked={v.branchMode === 'new'} onChange={() => set('branchMode', 'new')} />
            New branch from <span className="font-mono">{repo.defaultBranch}</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="branchMode" checked={v.branchMode === 'existing'} onChange={() => set('branchMode', 'existing')} />
            Continue on an existing branch
          </label>
        </div>
        {v.branchMode === 'existing' && (
          <Field id="branch" label="Branch" hint="The agent starts from this branch’s latest commit and pushes to it. If it has an open PR, that PR is updated.">
            <NativeSelect id="branch" required value={v.targetBranch} onChange={(e) => set('targetBranch', e.target.value)} disabled={branches.isLoading}>
              <option value="">{branches.isLoading ? 'Loading branches…' : 'Choose a branch…'}</option>
              {branches.data?.branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.protected ? ' (protected)' : ''}
                </option>
              ))}
            </NativeSelect>
            {branches.data?.truncated && <p className="text-xs text-muted-foreground">Showing the first 1,000 branches.</p>}
          </Field>
        )}
      </fieldset>

      <details className="rounded-md border p-4" open={!!(v.scopePath || v.relatedTaskId || v.extraContext)}>
        <summary className="cursor-pointer text-sm font-medium">More options</summary>
        <div className="mt-4 grid gap-4">
          <Field id="scope" label="Limit to folder (optional)" hint="The agent may only read and edit files under this folder.">
            <Input id="scope" placeholder="e.g. packages/web" value={v.scopePath} onChange={(e) => set('scopePath', e.target.value)} />
          </Field>
          <Field id="related" label="Related task (optional)" hint="Its summary is added to the agent’s context, which is how you do follow-up work.">
            {v.relatedTaskId ? (
              <div className="flex items-center gap-2 text-sm">
                <span>{v.relatedLabel}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setV({ ...v, relatedTaskId: '', relatedLabel: '' })}>
                  Clear
                </Button>
              </div>
            ) : (
              <div className="relative">
                <Input id="related" placeholder="Search by title or key…" value={relatedQ} onChange={(e) => setRelatedQ(e.target.value)} autoComplete="off" />
                {relatedQ && related.data && related.data.length > 0 && (
                  <ul className="absolute z-10 mt-1 w-full rounded-md border bg-card shadow-md" role="listbox">
                    {related.data.map((t) => (
                      <li key={t.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            setV({ ...v, relatedTaskId: t.id, relatedLabel: `${t.key} · ${t.title}` });
                            setRelatedQ('');
                          }}
                        >
                          <span className="mr-2 font-mono text-xs text-muted-foreground">{t.key}</span>
                          {t.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Field>
          <Field id="ctx" label="Extra context (optional)" hint="Links, constraints, anything the agent should know.">
            <textarea id="ctx" className={textarea} value={v.extraContext} onChange={(e) => set('extraContext', e.target.value)} />
          </Field>
        </div>
      </details>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={v.createPrOnCompletion} onChange={(e) => set('createPrOnCompletion', e.target.checked)} />
        Open a pull request when tests pass
      </label>

      <PromptGuidePanel
        canReview={v.title.trim().length > 0}
        busy={review.isPending}
        error={review.error?.message ?? null}
        review={review.data ?? null}
        onReview={() =>
          review.mutate({
            repoId: repo.id,
            title: v.title,
            descriptionMd: v.descriptionMd,
            acceptanceCriteriaMd: v.acceptanceCriteriaMd,
            extraContext: v.extraContext || undefined,
          })
        }
        onApply={(rw) => {
          setV({ ...v, title: rw.title, descriptionMd: rw.descriptionMd, acceptanceCriteriaMd: rw.acceptanceCriteriaMd });
          review.reset();
        }}
        onDismiss={() => review.reset()}
      />

      {error && <Alert tone="destructive">{error}</Alert>}
      <div className="flex flex-wrap gap-2">{actions(submit)}</div>
      {submitting && <span className="sr-only">Saving…</span>}
    </form>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Form values → API input. Empty strings become "use the default" / null. */
export function toTaskInput(v: TaskFormValues) {
  return {
    title: v.title,
    descriptionMd: v.descriptionMd,
    acceptanceCriteriaMd: v.acceptanceCriteriaMd,
    priority: v.priority,
    ...(v.mode ? { mode: v.mode } : {}),
    scopePath: v.scopePath.trim() || null,
    branchMode: v.branchMode,
    targetBranch: v.branchMode === 'existing' ? v.targetBranch : null,
    relatedTaskId: v.relatedTaskId || null,
    extraContext: v.extraContext || null,
    createPrOnCompletion: v.createPrOnCompletion,
  };
}
