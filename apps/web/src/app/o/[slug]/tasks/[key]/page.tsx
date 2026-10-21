'use client';

import { STATUS_LABEL } from '@autodev/db/task-machine';
import { Alert, Avatar, Button, Card, CardContent, CardHeader, CardTitle, NativeSelect } from '@autodev/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ActivitySection, AttentionPanel, ChangesSection, DocumentsSection, TestsSection } from '@/components/task-agent';
import { Markdown } from '@/components/markdown';
import { FlagList, PromptScoreBadge } from '@/components/prompt-guide';
import { MODE_LABEL, PriorityLabel, StatusBadge } from '@/components/task-bits';
import { PROMPT_FLAGS, type PromptFlag } from '@autodev/protocol/prompt-check';
import { TaskForm, toTaskInput, type TaskFormValues } from '@/components/task-form';
import { relativeTime } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useEvents } from '@/lib/use-events';
import { useOrg } from '../../org-shell';
import { toast } from 'sonner';

type Task = RouterOutputs['tasks']['get'];

export default function TaskPage() {
  const { slug, key } = useParams<{ slug: string; key: string }>();
  const org = useOrg();
  const utils = trpc.useUtils();
  // Task and agent changes refetch this page; the poll is only a safety net if the stream drops.
  const q = trpc.tasks.get.useQuery({ key }, { refetchInterval: 60_000 });
  // This task's topic. Live test output only refreshes the log; anything else refreshes the page.
  useEvents(org.orgId, q.data ? [`task:${q.data.id}`] : [], (events) => {
    if (events.some((e) => e.type === 'test.log')) void utils.agent.jobLog.invalidate();
    if (events.some((e) => e.type !== 'test.log')) {
      void utils.tasks.invalidate();
      void utils.agent.invalidate();
    }
  });
  const [editing, setEditing] = useState(false);
  if (q.error) return <Alert tone="destructive">{q.error.message}</Alert>;
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const t = q.data;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0 space-y-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{t.key}</span>
            <span>·</span>
            <Link href={`/o/${slug}/repos/${t.repo.name}`} className="min-w-0 [overflow-wrap:anywhere] hover:underline">
              {t.repo.fullName}
            </Link>
          </div>
          <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">{t.title}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={t.status} />
            <PriorityLabel priority={t.priority} />
          </div>
        </div>
        <Actions task={t} onEdit={() => setEditing(true)} />
        {t.linkedTargets.length > 0 && <ApplyToLinked task={t} slug={slug} />}
        <AttentionPanel task={t} />
        {editing ? <EditTask task={t} onDone={() => setEditing(false)} /> : <Details task={t} />}
        <DocumentsSection task={t} />
        <ChangesSection task={t} />
        <TestsSection task={t} />
        <ActivitySection task={t} />
        <Timeline task={t} />
      </div>
      <aside className="space-y-4">
        <Card>
          <CardContent className="space-y-3 pt-6 text-sm">
            <Meta label="Owner">
              <span className="flex items-center gap-2">
                <Avatar src={t.ownerAvatar} alt={t.ownerLogin} className="h-5 w-5" />
                {t.ownerLogin}
              </span>
            </Meta>
            <Meta label="Workflow">{MODE_LABEL[t.mode]}</Meta>
            {t.promptScore !== null && (
              <Meta label="Prompt score">
                <PromptScoreBadge score={t.promptScore} />
                <FlagList className="mt-1.5 text-xs" flags={(t.promptScoreDetails?.flags ?? []).filter((f): f is PromptFlag => (PROMPT_FLAGS as readonly string[]).includes(f))} />
              </Meta>
            )}
            <Meta label="Branch">
              <span className="break-all font-mono text-xs">{t.workBranch}</span>
              <span className="block text-xs text-muted-foreground">{t.branchMode === 'new' ? `new, from ${t.repo.defaultBranch}` : 'existing branch'}</span>
            </Meta>
            <Meta label="Folder">{t.scopePath ? <span className="font-mono text-xs">{t.scopePath}</span> : 'Whole repository'}</Meta>
            <Meta label="Pull request">
              {t.pullRequests[0] ? (
                <a href={t.pullRequests[0].url} target="_blank" rel="noopener noreferrer" className="underline">
                  #{t.pullRequests[0].number} ({t.pullRequests[0].state})
                </a>
              ) : t.createPrOnCompletion ? (
                'Opened when tests pass'
              ) : (
                'Created with the Create PR button'
              )}
            </Meta>
            {t.source && (
              <Meta label="Ported from">
                <Link href={`/o/${slug}/tasks/${t.source.key}`} className="[overflow-wrap:anywhere] hover:underline">
                  <span className="font-mono text-xs">{t.source.key}</span> {t.source.title}
                </Link>
                <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{t.source.repoFullName}</span>
              </Meta>
            )}
            {t.ports.length > 0 && (
              <Meta label="Ported to">
                <ul className="space-y-1">
                  {t.ports.map((p) => (
                    <li key={p.key}>
                      <Link href={`/o/${slug}/tasks/${p.key}`} className="hover:underline">
                        <span className="font-mono text-xs">{p.key}</span> <span className="[overflow-wrap:anywhere]">{p.repoFullName}</span>
                      </Link>
                      <span className="block text-xs text-muted-foreground">{STATUS_LABEL[p.status]}</span>
                    </li>
                  ))}
                </ul>
              </Meta>
            )}
            {t.related && (
              <Meta label="Related task">
                <Link href={`/o/${slug}/tasks/${t.related.key}`} className="hover:underline">
                  <span className="font-mono text-xs">{t.related.key}</span> {t.related.title}
                </Link>
              </Meta>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function Actions({ task: t, onEdit }: { task: Task; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.tasks.get.invalidate({ key: t.key }), utils.tasks.list.invalidate()]);
  const start = trpc.tasks.start.useMutation({ onSuccess: refresh });
  const unqueue = trpc.tasks.unqueue.useMutation({ onSuccess: refresh });
  const cancel = trpc.tasks.cancel.useMutation({
    onSuccess: () => {
      toast.success(`${t.key} cancelled`);
      return refresh();
    },
  });
  const error = start.error ?? unqueue.error ?? cancel.error;
  if (!Object.values(t.can).some(Boolean)) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {t.can.start && (
          <Button onClick={() => start.mutate({ key: t.key })} disabled={start.isPending}>
            {t.status === 'failed' ? 'Retry' : 'Start'}
          </Button>
        )}
        {t.can.edit && (
          <Button variant="outline" onClick={onEdit}>
            Edit
          </Button>
        )}
        {t.can.unqueue && (
          <Button variant="outline" onClick={() => unqueue.mutate({ key: t.key })} disabled={unqueue.isPending}>
            Move back to draft
          </Button>
        )}
        {t.can.cancel && (
          <Button variant="ghost" onClick={() => confirm(`Cancel ${t.key}?`) && cancel.mutate({ key: t.key })} disabled={cancel.isPending}>
            Cancel task
          </Button>
        )}
      </div>
      {error && <Alert tone="destructive">{error.message}</Alert>}
      {t.status === 'queued' && <Alert>Queued. The agent starts shortly.</Alert>}
    </div>
  );
}

/** Cross-repo sync (B-3): a draft in a linked repo that ports this change. Opens it when made. */
function ApplyToLinked({ task: t, slug }: { task: Task; slug: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [target, setTarget] = useState(t.linkedTargets[0]!.id);
  const apply = trpc.tasks.applyToLinked.useMutation({
    onSuccess: async (port) => {
      toast.success(`${port.key} created as a draft. Review it, then start it.`);
      await utils.tasks.invalidate();
      router.push(`/o/${slug}/tasks/${port.key}`);
    },
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {t.linkedTargets.length > 1 && (
          <NativeSelect aria-label="Linked repository" value={target} onChange={(e) => setTarget(e.target.value)} className="w-auto max-w-full">
            {t.linkedTargets.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </NativeSelect>
        )}
        <Button variant="outline" onClick={() => apply.mutate({ key: t.key, targetRepoId: target })} disabled={apply.isPending}>
          {apply.isPending ? 'Reading the change…' : `Apply to ${t.linkedTargets.length > 1 ? 'linked repo' : t.linkedTargets[0]!.fullName}`}
        </Button>
      </div>
      {apply.error && <Alert tone="destructive">{apply.error.message}</Alert>}
    </div>
  );
}

function Details({ task: t }: { task: Task }) {
  return (
    <div className="space-y-4">
      <Section title="Description">{t.descriptionMd ? <Prose text={t.descriptionMd} /> : <Empty />}</Section>
      <Section title="Acceptance criteria">{t.acceptanceCriteriaMd ? <Prose text={t.acceptanceCriteriaMd} /> : <Empty />}</Section>
      {t.extraContext && (
        <Section title="Extra context">
          <Prose text={t.extraContext} />
        </Section>
      )}
      {t.related?.summaryMd && (
        <Section title={`From ${t.related.key}`}>
          <Prose text={t.related.summaryMd} />
        </Section>
      )}
      {t.sourceContextMd && (
        <Section title="The change to port">
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm">What the agent gets from {t.source?.key ?? 'the source task'}, as it was when this task was created</summary>
            <div className="mt-2 min-w-0 overflow-x-auto">
              <Markdown text={t.sourceContextMd} />
            </div>
          </details>
        </Section>
      )}
    </div>
  );
}

function EditTask({ task: t, onDone }: { task: Task; onDone: () => void }) {
  const utils = trpc.useUtils();
  const update = trpc.tasks.update.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.tasks.get.invalidate({ key: t.key }), utils.tasks.list.invalidate()]);
      onDone();
    },
  });
  const repo = trpc.repos.byName.useQuery({ name: t.repo.name });
  if (!repo.data) return null;
  const initial: TaskFormValues = {
    title: t.title,
    descriptionMd: t.descriptionMd,
    acceptanceCriteriaMd: t.acceptanceCriteriaMd,
    priority: t.priority,
    mode: t.mode,
    scopePath: t.scopePath ?? '',
    branchMode: t.branchMode,
    targetBranch: t.targetBranch ?? '',
    relatedTaskId: t.relatedTaskId ?? '',
    relatedLabel: t.related ? `${t.related.key} · ${t.related.title}` : '',
    extraContext: t.extraContext ?? '',
    createPrOnCompletion: t.createPrOnCompletion,
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit task</CardTitle>
      </CardHeader>
      <CardContent>
        <TaskForm
          repo={repo.data}
          initial={initial}
          submitting={update.isPending}
          error={update.error?.message}
          onSubmit={(v) => update.mutate({ key: t.key, ...toTaskInput(v) })}
          actions={() => (
            <>
              <Button type="submit" disabled={update.isPending}>
                Save
              </Button>
              <Button type="button" variant="ghost" onClick={onDone}>
                Cancel
              </Button>
            </>
          )}
        />
      </CardContent>
    </Card>
  );
}

function Timeline({ task: t }: { task: Task }) {
  return (
    <Section title="Activity">
      <ol className="space-y-2 text-sm">
        {t.events.map((e) => (
          <li key={e.id} className="flex flex-wrap gap-x-2">
            <span className="font-medium">{e.actorLogin ?? (e.actorType === 'agent' ? 'Agent' : 'AutoDev')}</span>
            <span className="text-muted-foreground">
              {e.type === 'created'
                ? 'created the task'
                : e.type === 'edited'
                  ? 'edited the task'
                  : e.type === 'status_changed'
                    ? `moved it to ${STATUS_LABEL[e.toStatus!]}`
                    : e.type === 'ported'
                      ? `applied it to ${String(e.payload.repo)} as ${String(e.payload.portKey)}`
                      : (EVENT_LABEL[e.type] ?? e.type)}
              {typeof e.payload.reason === 'string' && `: ${e.payload.reason}`}
            </span>
            <span className="text-xs text-muted-foreground">{relativeTime(e.createdAt)}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

const EVENT_LABEL: Record<string, string> = {
  'tests.passed': 'reported that the tests passed',
  'branch.pushed': 'pushed the change',
  'pr.opened': 'opened the pull request',
  'pr.updated': 'updated the pull request',
  'pr.merged': 'saw the pull request merged',
  'pr.closed': 'saw the pull request closed',
  'pr.reopened': 'saw the pull request reopened',
  'pr.failed': 'could not open the pull request',
  'source_pr.updated': 'linked this PR from the source task’s PR',
  'source_pr.not_updated': 'could not link this PR from the source task’s PR',
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <h2 className="mb-1.5 text-sm font-medium text-muted-foreground">{title}</h2>
    {children}
  </section>
);
const Meta = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <div className="text-xs text-muted-foreground">{label}</div>
    <div>{children}</div>
  </div>
);
/** Task fields are written by people; shown as plain text with line breaks. */
const Prose = ({ text }: { text: string }) => <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</div>;
const Empty = () => <p className="text-sm text-muted-foreground">None</p>;
