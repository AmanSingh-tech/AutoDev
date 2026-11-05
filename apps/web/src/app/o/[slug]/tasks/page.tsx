'use client';

import { Button } from '@autodev/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { PageHeader } from '@/components/page-header';
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
      <PageHeader
        title="Tasks"
        description={`All tasks in ${org.name}. Each repository also has its own board.`}
        actions={
          <Button asChild>
            <Link href={`/o/${org.slug}/tasks/new`}>
              <Plus aria-hidden />
              New task
            </Link>
          </Button>
        }
        className="mb-2"
      />
      <TaskFilters value={filters} onChange={setFilters} />
      {tasks.data && <TaskTable slug={org.slug} rows={tasks.data} showRepo filtered={JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS)} />}
    </section>
  );
}
