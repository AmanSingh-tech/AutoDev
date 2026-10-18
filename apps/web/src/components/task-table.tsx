'use client';

import { Avatar, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import Link from 'next/link';
import { relativeTime } from '@/lib/format';
import type { RouterOutputs } from '@/lib/trpc';
import { PriorityLabel, StatusBadge } from './task-bits';

type Row = RouterOutputs['tasks']['list'][number];

export function TaskTable({ slug, rows, showRepo }: { slug: string; rows: Row[]; showRepo?: boolean }) {
  if (!rows.length) return <p className="py-8 text-center text-sm text-muted-foreground">No tasks match.</p>;
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
            <TD>
              <Link href={`/o/${slug}/tasks/${t.key}`} className="hover:underline">
                <span className="mr-2 font-mono text-xs text-muted-foreground">{t.key}</span>
                <span className="font-medium">{t.title}</span>
              </Link>
            </TD>
            {showRepo && (
              <TD>
                <Link href={`/o/${slug}/repos/${t.repoName}`} className="text-muted-foreground hover:underline">
                  {t.repoName}
                </Link>
              </TD>
            )}
            <TD>
              <StatusBadge status={t.status} />
            </TD>
            <TD>
              <PriorityLabel priority={t.priority} />
            </TD>
            <TD>
              <span className="flex items-center gap-2">
                <Avatar src={t.ownerAvatar} alt={t.ownerLogin} className="h-5 w-5" />
                {t.ownerLogin}
              </span>
            </TD>
            <TD className="text-right text-muted-foreground">{relativeTime(t.updatedAt)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
