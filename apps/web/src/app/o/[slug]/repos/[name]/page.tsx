'use client';

import { BOARD_COLUMNS, columnOf } from '@autodev/db/task-machine';
import type { TaskMode } from '@autodev/db/schema';
import { Alert, Avatar, Button, cn, NativeSelect } from '@autodev/ui';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useDeferredValue, useState } from 'react';
import { MODE_LABEL, PriorityLabel, StatusBadge } from '@/components/task-bits';
import { EMPTY_FILTERS, TaskFilters, toQuery } from '@/components/task-filters';
import { TaskTable } from '@/components/task-table';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useTaskChanges } from '@/lib/use-task-changes';
import { useOrg } from '../../org-shell';

type Task = RouterOutputs['tasks']['list'][number];

export default function RepoBoardPage() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  const org = useOrg();
  const router = useRouter();
  const search = useSearchParams();
  const view = search.get('view') === 'list' ? 'list' : 'board';
  const repo = trpc.repos.byName.useQuery({ name });
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const deferred = useDeferredValue(filters);
  const utils = trpc.useUtils();
  // Task changes refetch the board; the poll is only a safety net if the stream drops.
  useTaskChanges(org.orgId, () => void utils.tasks.invalidate());
  const tasks = trpc.tasks.list.useQuery({ repoId: repo.data?.id, ...toQuery(view === 'board' ? { ...deferred, column: '' } : deferred) }, { enabled: !!repo.data, refetchInterval: 60_000 });

  if (repo.error) return <Alert tone="destructive">{repo.error.message}</Alert>;
  if (!repo.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const setView = (v: 'board' | 'list') => router.replace(`/o/${slug}/repos/${name}${v === 'list' ? '?view=list' : ''}`);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{repo.data.fullName}</h1>
          <ModePolicy repo={repo.data} canEdit={org.role === 'owner' || org.role === 'admin'} />
        </div>
        <div className="flex gap-2">
          <div className="flex rounded-md border p-0.5" role="group" aria-label="View">
            {(['board', 'list'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={cn('rounded px-3 py-1 text-sm capitalize', view === v && 'bg-muted font-medium')}>
                {v}
              </button>
            ))}
          </div>
          {repo.data.canCreate && (
            <Button asChild>
              <Link href={`/o/${slug}/repos/${name}/new`}>New task</Link>
            </Button>
          )}
        </div>
      </div>
      <TaskFilters value={filters} onChange={setFilters} showColumn={view === 'list'} />
      {view === 'list' ? tasks.data && <TaskTable slug={slug} rows={tasks.data} /> : <Board slug={slug} tasks={tasks.data ?? []} />}
    </section>
  );
}

/** Six columns. Only a draft can be dragged, and only to Queued (that starts it); everything else moves by itself. */
function Board({ slug, tasks }: { slug: string; tasks: Task[] }) {
  const utils = trpc.useUtils();
  const [dragging, setDragging] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = trpc.tasks.start.useMutation({
    onSuccess: () => utils.tasks.list.invalidate(),
    onError: (e) => setError(e.message),
  });

  return (
    <div className="space-y-3">
      {error && (
        <Alert tone="destructive" className="flex items-center justify-between gap-3">
          <span>{error}</span>
          <button className="text-xs underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </Alert>
      )}
      <div className="-mx-4 overflow-x-auto px-4 pb-2">
        <div className="grid min-w-[1040px] grid-cols-6 gap-3">
          {BOARD_COLUMNS.map((col) => {
            const items = tasks.filter((t) => columnOf(t.status) === col.id);
            const dropTarget = col.id === 'queued' && dragging?.status === 'draft';
            return (
              <div
                key={col.id}
                data-testid={`column-${col.id}`}
                aria-label={`${col.label}, ${items.length} tasks`}
                className={cn('flex min-h-[200px] flex-col rounded-lg bg-muted/50 p-2', dropTarget && 'ring-2 ring-viz-accent')}
                onDragOver={(e) => dropTarget && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dropTarget && dragging) {
                    setError(null);
                    start.mutate({ key: dragging.key });
                  }
                  setDragging(null);
                }}
              >
                <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-medium">
                  {col.label}
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </h2>
                <ul className="space-y-2">
                  {items.map((t) => (
                    <li
                      key={t.id}
                      draggable={t.status === 'draft'}
                      onDragStart={() => setDragging(t)}
                      onDragEnd={() => setDragging(null)}
                      className={cn('rounded-md border bg-card p-3 text-sm shadow-sm', t.status === 'draft' && 'cursor-grab')}
                    >
                      <Link href={`/o/${slug}/tasks/${t.key}`} className="block space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs text-muted-foreground">{t.key}</span>
                          <PriorityLabel priority={t.priority} />
                        </div>
                        <div className="font-medium leading-snug">{t.title}</div>
                        <div className="flex items-center justify-between gap-2">
                          {col.id === 'draft' ? <span className="text-xs text-muted-foreground">{MODE_LABEL[t.mode]}</span> : <StatusBadge status={t.status} className="min-w-0 max-w-full" />}
                          <Avatar src={t.ownerAvatar} alt={t.ownerLogin} className="h-5 w-5 shrink-0" />
                        </div>
                      </Link>
                      {t.status === 'draft' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2 w-full"
                          disabled={start.isPending}
                          onClick={() => {
                            setError(null);
                            start.mutate({ key: t.key });
                          }}
                        >
                          Start
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ModePolicy({ repo, canEdit }: { repo: { id: string; lockedMode: TaskMode | null; defaultMode: TaskMode | null }; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const save = trpc.repos.setPolicy.useMutation({ onSuccess: () => utils.repos.byName.invalidate() });
  const text = repo.lockedMode ? `Locked to ${MODE_LABEL[repo.lockedMode]}` : repo.defaultMode ? `Default workflow: ${MODE_LABEL[repo.defaultMode]}` : 'Uses the organization’s default workflow';
  if (!canEdit) return <p className="text-sm text-muted-foreground">{text}</p>;
  const value = repo.lockedMode ? `lock:${repo.lockedMode}` : repo.defaultMode ? `default:${repo.defaultMode}` : '';
  return (
    <label className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
      Workflow
      <NativeSelect
        aria-label="Repository workflow"
        className="h-8 w-64"
        value={value}
        disabled={save.isPending}
        onChange={(e) => {
          const [kind, mode] = e.target.value.split(':') as ['lock' | 'default' | '', TaskMode | undefined];
          save.mutate({ repoId: repo.id, lockedMode: kind === 'lock' ? mode! : null, defaultMode: kind === 'default' ? mode! : null });
        }}
      >
        <option value="">Organization default</option>
        {(Object.keys(MODE_LABEL) as TaskMode[]).map((m) => (
          <option key={`d${m}`} value={`default:${m}`}>
            Default: {MODE_LABEL[m]}
          </option>
        ))}
        {(Object.keys(MODE_LABEL) as TaskMode[]).map((m) => (
          <option key={`l${m}`} value={`lock:${m}`}>
            Locked: {MODE_LABEL[m]}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}
