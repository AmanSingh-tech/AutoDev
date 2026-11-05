'use client';

import { Input } from '@autodev/ui';
import { ChevronRight, FolderGit2, Lock, Search } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState, PageHeader } from '@/components/page-header';
import { trpc } from '@/lib/trpc';

/** "New task" from anywhere: pick the repository first (tasks live in a repo). */
export default function NewTaskPickRepo() {
  const { slug } = useParams<{ slug: string }>();
  const repos = trpc.repos.list.useQuery();
  const [q, setQ] = useState('');
  const list = (repos.data ?? []).filter((r) => r.fullName.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New task" description="Which repository should the agent work in? You can only pick repositories you can push to." />
      {repos.data && repos.data.length > 6 && (
        <div className="relative mb-3">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Filter repositories" aria-label="Filter repositories" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>
      )}
      {repos.data && repos.data.length === 0 ? (
        <EmptyState icon={FolderGit2} title="No repositories you can push to">
          AutoDev lists the repositories the GitHub App is installed on where you have write access.
        </EmptyState>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
          {!repos.data && <li className="px-4 py-6 text-sm text-muted-foreground">Loading…</li>}
          {list.map((r) => (
            <li key={r.id}>
              <Link href={`/o/${slug}/repos/${r.name}/new`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary">
                <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.fullName}</span>
                {r.private && <Lock aria-label="Private" className="size-3.5 text-muted-foreground" />}
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
