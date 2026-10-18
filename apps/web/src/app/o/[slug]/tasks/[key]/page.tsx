'use client';

import { STATUS_LABEL } from '@autodev/db/task-machine';
import { Alert, Avatar, Button, Card, CardContent, CardHeader, CardTitle } from '@autodev/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ActivitySection, AttentionPanel, ChangesSection, DocumentsSection } from '@/components/task-agent';
import { MODE_LABEL, PriorityLabel, StatusBadge } from '@/components/task-bits';
import { TaskForm, toTaskInput, type TaskFormValues } from '@/components/task-form';
import { relativeTime } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Task = RouterOutputs['tasks']['get'];

export default function TaskPage() {
  const { slug, key } = useParams<{ slug: string; key: string }>();
  const q = trpc.tasks.get.useQuery({ key }, { refetchInterval: 15_000 });
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
            <Link href={`/o/${slug}/repos/${t.repo.name}`} className="hover:underline">
              {t.repo.fullName}
            </Link>
          </div>
          <h1 className="text-2xl font-semibold">{t.title}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={t.status} />
            <PriorityLabel priority={t.priority} />
          </div>
        </div>
        <Actions task={t} onEdit={() => setEditing(true)} />
        <AttentionPanel task={t} />
        {editing ? <EditTask task={t} onDone={() => setEditing(false)} /> : <Details task={t} />}
        <DocumentsSection task={t} />
        <ChangesSection task={t} />
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
            <Meta label="Branch">
              <span className="break-all font-mono text-xs">{t.workBranch}</span>
              <span className="block text-xs text-muted-foreground">{t.branchMode === 'new' ? `new, from ${t.repo.defaultBranch}` : 'existing branch'}</span>
            </Meta>
            <Meta label="Folder">{t.scopePath ? <span className="font-mono text-xs">{t.scopePath}</span> : 'Whole repository'}</Meta>
            <Meta label="Pull request">{t.createPrOnCompletion ? 'Opened automatically' : 'Created manually'}</Meta>
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
  const cancel = trpc.tasks.cancel.useMutation({ onSuccess: refresh });
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
                    : e.type}
              {typeof e.payload.reason === 'string' && `: ${e.payload.reason}`}
            </span>
            <span className="text-xs text-muted-foreground">{relativeTime(e.createdAt)}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

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
