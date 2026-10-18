'use client';

import { useDeferredValue, useState } from 'react';
import { EMPTY_FILTERS, TaskFilters, toQuery } from '@/components/task-filters';
import { TaskTable } from '@/components/task-table';
import { trpc } from '@/lib/trpc';
import { useOrg } from '../org-shell';

/** Every task in the org, across repos. Viewers use this too. */
export default function TasksPage() {
  const org = useOrg();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const deferred = useDeferredValue(filters);
  const tasks = trpc.tasks.list.useQuery(toQuery(deferred), { refetchInterval: 15_000 });
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Tasks</h1>
        <p className="text-sm text-muted-foreground">All tasks in {org.name}. Open a repository to see its board or to create tasks.</p>
      </div>
      <TaskFilters value={filters} onChange={setFilters} />
      {tasks.data && <TaskTable slug={org.slug} rows={tasks.data} showRepo />}
    </section>
  );
}
