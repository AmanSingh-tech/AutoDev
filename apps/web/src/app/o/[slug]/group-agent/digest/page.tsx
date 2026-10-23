'use client';

import { Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { HealthBadge, KIND_LABEL, SeverityBadge } from '@/components/group-agent-bits';
import { StatTile } from '@/components/stat-tile';
import { int } from '@/lib/format';
import { trpc } from '@/lib/trpc';

/** The latest weekly digest: health per repo against the week before, top risks, what changed. */
export default function DigestPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = trpc.groupAgent.digest.useQuery();
  const d = q.data;
  return (
    <div className="space-y-6">
      <div>
        <Link href={`/o/${slug}/group-agent`} className="text-sm text-muted-foreground hover:underline">
          ← Group Agent
        </Link>
        <h1 className="text-xl font-semibold">Weekly digest</h1>
        {d && (
          <p className="text-sm text-muted-foreground">
            {new Date(d.at).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })}, covering changes since{' '}
            {new Date(d.since).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })}. Sent to admins every Monday.
          </p>
        )}
      </div>
      {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}
      {q.data === null && <p className="text-sm text-muted-foreground">No digest yet. The first one goes out on Monday at 08:00 UTC once the Group Agent is on.</p>}
      {d && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatTile label="Open findings" value={int(d.openFindings)} />
            <StatTile label="New this week" value={int(d.newFindings)} />
            <StatTile label="Resolved this week" value={int(d.resolvedFindings)} />
          </div>
          <section aria-labelledby="risks" className="space-y-2">
            <h2 id="risks" className="text-sm font-medium">
              Top risks
            </h2>
            {d.topRisks.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing open.</p>
            ) : (
              <ol className="space-y-2">
                {d.topRisks.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <SeverityBadge severity={r.severity} />
                    <span className={r.resolvedSince ? 'text-muted-foreground line-through' : ''}>{r.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {KIND_LABEL[r.kind] ?? r.kind}
                      {r.resolvedSince ? ' · resolved since' : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-labelledby="repos" className="space-y-2">
            <h2 id="repos" className="text-sm font-medium">
              Repository health
            </h2>
            <Table>
              <THead>
                <TR>
                  <TH className="min-w-[12rem]">Repository</TH>
                  <TH className="text-right">Health</TH>
                  <TH className="text-right">Week before</TH>
                  <TH className="text-right">Change</TH>
                </TR>
              </THead>
              <TBody>
                {d.repos.map((r) => {
                  const delta = r.previous === null ? null : r.score - r.previous;
                  return (
                    <TR key={r.repoId}>
                      <TD className="max-w-[20rem] truncate" title={r.name}>
                        {r.name}
                      </TD>
                      <TD className="text-right">
                        <HealthBadge score={r.score} />
                      </TD>
                      <TD className="text-right tabular-nums text-muted-foreground">{r.previous ?? '—'}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{delta === null ? '—' : delta === 0 ? 'no change' : delta > 0 ? `▲ ${delta}` : `▼ ${-delta}`}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </section>
        </>
      )}
    </div>
  );
}
