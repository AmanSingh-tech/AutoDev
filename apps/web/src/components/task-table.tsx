'use client';

import { Avatar, Button, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import Link from 'next/link';
import { relativeTime } from '@/lib/format';
import type { RouterOutputs } from '@/lib/trpc';
import { PriorityLabel, StatusBadge } from './task-bits';

import { ListChecks, Plus, SearchX } from 'lucide-react';
import { EmptyState } from './page-header';

type Row = RouterOutputs['tasks']['list'][number];

export function TaskTable({ slug, rows, showRepo, filtered = true }: { slug: string; rows: Row[]; showRepo?: boolean; filtered?: boolean }) {
  if (!rows.length)
    return filtered ? (
      <EmptyState icon={SearchX} title="No tasks match these filters">
        Try another status or priority, or clear the search.
      </EmptyState>
    ) : (
      <EmptyState
        icon={ListChecks}
        title="No tasks yet"
        action={
          <Button asChild>
            <Link href={`/o/${slug}/tasks/new`}>
              <Plus aria-hidden />
              Create the first task
            </Link>
          </Button>
        }
      >
        Describe a bug fix or a feature. The agent plans it, you approve, and it opens the pull request.
      </EmptyState>
    );
  return (
    <Table>
      <THead>
        <TR>
          <TH>Task</TH>
          {showRepo && <TH>Repository</TH>}
          <TH>Status</TH>
          <TH>Priority</TH>
          <TH>Owner</TH>
          <TH className="text-right">Updated</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((t) => (
          <TR key={t.id}>
            {/* A floor for the title column: on phones the table scrolls sideways instead of
                squeezing titles to two words a line. Up to 3 lines, full title on hover. */}
            <TD className="min-w-[15rem] max-w-[40rem]">
              <Link href={`/o/${slug}/tasks/${t.key}`} className="line-clamp-3 break-words hover:underline" title={t.title}>
                <span className="mr-2 whitespace-nowrap font-mono text-xs text-muted-foreground">{t.key}</span>
                <span className="font-medium">{t.title}</span>
              </Link>
            </TD>
            {showRepo && (
              <TD>
                <Link href={`/o/${slug}/repos/${t.repoName}`} title={t.repoName} className="block max-w-[11rem] truncate text-muted-foreground hover:underline">
                  {t.repoName}
                </Link>
              </TD>
            )}
            <TD className="whitespace-nowrap">
              <StatusBadge status={t.status} />
            </TD>
            <TD className="whitespace-nowrap">
              <PriorityLabel priority={t.priority} />
            </TD>
            <TD>
              <span className="flex items-center gap-2">
                <Avatar src={t.ownerAvatar} alt={t.ownerLogin} className="h-5 w-5 shrink-0" />
                {t.ownerLogin}
              </span>
            </TD>
            <TD className="whitespace-nowrap text-right text-muted-foreground">{relativeTime(t.updatedAt)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
