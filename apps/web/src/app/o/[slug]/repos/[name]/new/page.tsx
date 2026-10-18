'use client';

import { Button } from '@autodev/ui';
import { useParams, useRouter } from 'next/navigation';
import { emptyTask, TaskForm, toTaskInput } from '@/components/task-form';
import { trpc } from '@/lib/trpc';

export default function NewTaskPage() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  const router = useRouter();
  const utils = trpc.useUtils();
  const repo = trpc.repos.byName.useQuery({ name });
  const create = trpc.tasks.create.useMutation({
    onSuccess: (t) => {
      void utils.tasks.list.invalidate();
      router.push(`/o/${slug}/tasks/${t.key}`);
    },
  });

  if (!repo.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!repo.data.canCreate) return <p className="text-sm">You need push access to {repo.data.fullName} on GitHub to create tasks here.</p>;
  return (
    <section className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">New task in {repo.data.fullName}</h1>
      <TaskForm
        repo={repo.data}
        initial={emptyTask()}
        submitting={create.isPending}
        error={create.error?.message}
        onSubmit={(v, start) => create.mutate({ repoId: repo.data!.id, ...toTaskInput(v), start })}
        actions={(submit) => (
          <>
            <Button type="button" disabled={create.isPending} onClick={() => submit(true)}>
              Create and start
            </Button>
            <Button type="submit" variant="outline" disabled={create.isPending}>
              Save as draft
            </Button>
          </>
        )}
      />
    </section>
  );
}
