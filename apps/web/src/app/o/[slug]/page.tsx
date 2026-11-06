'use client';

import { Button, Card, CardContent, CardHeader, CardTitle, cn } from '@autodev/ui';
import { ArrowRight, CircleCheck, Coins, FolderGit2, GitMerge, GitPullRequest, Hand, ListChecks, Loader, MoonStar, Plus, Server, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { EmptyState, PageHeader } from '@/components/page-header';
import { StatTile } from '@/components/stat-tile';
import { StatusBadge } from '@/components/task-bits';
import { relativeTime, usd } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useOrg } from './org-shell';

type Dashboard = RouterOutputs['dashboard']['get'];

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

/** The org home: what needs you, what's running, recent pull requests and the month so far. */
export default function OrgHome() {
  const { slug } = useParams<{ slug: string }>();
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const me = trpc.me.get.useQuery();
  const q = trpc.dashboard.get.useQuery(undefined, { refetchInterval: 30_000 });
  const onboarding = trpc.onboarding.status.useQuery(undefined, { enabled: isAdmin });
  const firstName = (me.data?.user?.name ?? me.data?.user?.githubLogin ?? '').split(' ')[0];
  const d = q.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
        description={d?.scope === 'org' ? `Here’s what’s happening across ${org.name}.` : 'Here’s what’s happening with your tasks.'}
        actions={
          <Button asChild>
            <Link href={`/o/${slug}/tasks/new`}>
              <Plus aria-hidden />
              New task
            </Link>
          </Button>
        }
      />

      {isAdmin && !org.demo && onboarding.data && !onboarding.data.complete && !onboarding.data.dismissed && <SetupCard slug={slug} steps={onboarding.data.steps} />}

      <AutopilotMorning slug={slug} />

      <section aria-label="This week" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={ListChecks} label="Tasks this week" value={d ? String(d.stats.tasksThisWeek) : '–'} />
        <StatTile icon={GitMerge} label="Merged this week" value={d ? String(d.stats.mergedThisWeek) : '–'} />
        <StatTile icon={Coins} label="AI spend this month" value={d ? usd(d.stats.spendThisMonthUsd) : '–'} hint={d?.scope === 'mine' ? 'Your usage' : undefined} />
        <StatTile icon={Server} label="Builders online" value={d ? `${d.stats.buildersOnline} / ${d.stats.builders}` : '–'} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <TaskList
          title="Needs you"
          icon={Hand}
          tone="warning"
          slug={slug}
          tasks={d?.attention}
          empty="Nothing is waiting on you. Plans and designs to approve, and questions from the agent, show up here."
        />
        <TaskList
          title="In progress"
          icon={Loader}
          tone="accent"
          slug={slug}
          tasks={d?.running}
          empty="No task is running right now."
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2">
            <GitPullRequest aria-hidden className="size-4 text-muted-foreground" />
            Recent pull requests
          </CardTitle>
          <Link href={`/o/${slug}/tasks`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            All tasks <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {d && d.prs.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState icon={Sparkles} title="No pull requests yet" action={<Button asChild variant="outline"><Link href={`/o/${slug}/tasks/new`}>Create your first task</Link></Button>}>
                When the agent finishes a task, its pull request appears here.
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y">
              {(d?.prs ?? []).map((pr) => (
                <li key={pr.url} className="flex items-center gap-3 px-6 py-3">
                  {pr.mergedAt ? <GitMerge aria-hidden className="size-4 shrink-0 text-primary" /> : <GitPullRequest aria-hidden className={cn('size-4 shrink-0', pr.state === 'open' ? 'text-success' : 'text-muted-foreground')} />}
                  <div className="min-w-0 flex-1">
                    <Link href={`/o/${slug}/tasks/${pr.taskKey}`} className="block truncate text-sm font-medium hover:underline">
                      {pr.title}
                    </Link>
                    <div className="truncate text-xs text-muted-foreground">
                      {pr.repoFullName} #{pr.number} · {pr.mergedAt ? `merged ${relativeTime(pr.mergedAt)}` : `${pr.state} · opened ${relativeTime(pr.createdAt)}`}
                    </div>
                  </div>
                  {org.demo ? (
                    <Link href={`/o/${slug}/tasks/${pr.taskKey}`} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                      View
                    </Link>
                  ) : (
                    <a href={pr.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                      GitHub ↗
                    </a>
                  )}
                </li>
              ))}
              {!d && <li className="px-6 py-6 text-sm text-muted-foreground">Loading…</li>}
            </ul>
          )}
        </CardContent>
      </Card>

      {d && d.stats.repos === 0 && (
        <EmptyState icon={FolderGit2} title="No repositories yet" action={isAdmin ? <Button asChild variant="outline"><Link href={`/o/${slug}/repos`}>Choose repositories</Link></Button> : undefined}>
          AutoDev works in the repositories the GitHub App is installed on.
        </EmptyState>
      )}
    </div>
  );
}

function TaskList({ title, icon: Icon, tone, slug, tasks, empty }: { title: string; icon: typeof Hand; tone: 'warning' | 'accent'; slug: string; tasks: Dashboard['attention'] | undefined; empty: string }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <span className={cn('flex size-6 items-center justify-center rounded-md', tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-accent text-accent-foreground')}>
            <Icon aria-hidden className="size-3.5" />
          </span>
          {title}
          {tasks && tasks.length > 0 && <span className="text-sm font-normal text-muted-foreground">{tasks.length}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 pb-2">
        {!tasks ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="flex items-start gap-2 px-6 pb-4 text-sm text-muted-foreground">
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            {empty}
          </p>
        ) : (
          <ul>
            {tasks.map((t) => (
              <li key={t.key}>
                <Row href={`/o/${slug}/tasks/${t.key}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{t.key}</span> · {t.repo} · {relativeTime(t.updatedAt)}
                    </div>
                  </div>
                  <StatusBadge status={t.status} className="shrink-0" />
                </Row>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const Row = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="mx-2 flex items-center gap-3 rounded-lg px-4 py-2.5 transition-colors hover:bg-secondary">
    {children}
  </Link>
);

/** Until setup is done, the checklist leads the page for admins. */
function SetupCard({ slug, steps }: { slug: string; steps: { id: string; done: boolean }[] }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card p-5 shadow-card">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Finish setting up AutoDev</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {done} of {steps.length} steps done. A few minutes more and your team can hand off its first task.
          </p>
          <div className="mt-3 h-1.5 max-w-sm overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label="Setup progress">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${(done / steps.length) * 100}%` }} />
          </div>
        </div>
        <Button asChild>
          <Link href={`/o/${slug}/onboarding`}>
            Continue setup <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** After an Autopilot run: what it left for you to review. */
function AutopilotMorning({ slug }: { slug: string }) {
  const q = trpc.autopilot.get.useQuery(undefined, { staleTime: 60_000 });
  const run = q.data?.runs.find((r) => r.status === 'done' && r.tasks.length > 0);
  const toReview = run?.tasks.filter((t) => t.prState === 'open' && t.prDraft).length ?? 0;
  if (!run || !toReview) return null;
  return (
    <Link href={`/o/${slug}/autopilot`} className="group flex items-center gap-4 rounded-xl border border-primary/30 bg-accent/50 p-4 shadow-card transition-colors hover:bg-accent">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <MoonStar aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">
          Autopilot finished {toReview} task{toReview === 1 ? '' : 's'} {run.endedAt ? relativeTime(run.endedAt) : ''}
        </span>
        <span className="block text-sm text-muted-foreground">
          {toReview} draft pull request{toReview === 1 ? '' : 's'} waiting for your review.
        </span>
      </span>
      <ArrowRight aria-hidden className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
