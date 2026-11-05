'use client';

import { Button, cn } from '@autodev/ui';
import { ChevronDown, CircleCheck, Circle, RotateCcw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';

/** The tour, pointing at the sample data every demo org is created with. */
const STEPS: { path: string; label: string; hint: string }[] = [
  { path: '/tasks/ACME-1', label: 'Approve a plan', hint: 'The agent planned a bug fix. Approve it and watch the design, code, tests and PR follow.' },
  { path: '/tasks/ACME-8', label: 'Answer the agent', hint: 'It stopped to ask a question instead of guessing.' },
  { path: '/tasks/ACME-4', label: 'Merge a pull request', hint: 'Review the diff and test run, then merge.' },
  { path: '/repos/api/chat', label: 'Ask the codebase', hint: 'A private chat that answers from the repository.' },
  { path: '/group-agent', label: 'See what the Group Agent found', hint: 'Nightly scans, recommendations and a weekly digest.' },
  { path: '/insights', label: 'Open Insights', hint: 'Cost, merged PRs and the leaderboard.' },
];

const key = (slug: string) => `autodev-demo-tour:${slug}`;
function load(slug: string): { open: boolean; seen: string[] } {
  try {
    return JSON.parse(localStorage.getItem(key(slug)) ?? '') as { open: boolean; seen: string[] };
  } catch {
    return { open: true, seen: [] };
  }
}
function save(slug: string, v: { open: boolean; seen: string[] }) {
  try {
    localStorage.setItem(key(slug), JSON.stringify(v));
  } catch {
    // Private windows: the tour just doesn't remember.
  }
}

/** The demo notice with a short tour (ticks off as you visit each step) and "Reset demo". */
export function DemoGuide({ slug, isOwner }: { slug: string; isOwner: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [state, setState] = useState<{ open: boolean; seen: string[] }>({ open: true, seen: [] });
  useEffect(() => setState(load(slug)), [slug]);
  useEffect(() => {
    const here = STEPS.find((s) => pathname === `/o/${slug}${s.path}`);
    if (here && !state.seen.includes(here.path)) {
      const next = { ...state, seen: [...state.seen, here.path] };
      setState(next);
      save(slug, next);
    }
  }, [pathname, slug, state]);
  const reset = trpc.demo.reset.useMutation({
    onSuccess: async (r) => {
      await utils.me.get.invalidate();
      toast.success('A fresh demo is ready');
      router.push(`/o/${r.slug}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const toggle = () => {
    const next = { ...state, open: !state.open };
    setState(next);
    save(slug, next);
  };
  const done = state.seen.length;

  return (
    <section aria-label="Demo" className="mb-6 overflow-hidden rounded-xl border border-primary/20 bg-accent/50">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm text-accent-foreground">
        <Sparkles aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">Demo organization.</span> The agent is simulated: nothing reaches GitHub or an AI provider.
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" className="text-accent-foreground hover:bg-primary/10" onClick={toggle} aria-expanded={state.open}>
            {state.open ? 'Hide tour' : `Show me around (${done}/${STEPS.length})`}
            <ChevronDown aria-hidden className={cn('transition-transform', state.open && 'rotate-180')} />
          </Button>
          {isOwner && (
            <Button size="sm" variant="ghost" className="text-accent-foreground hover:bg-primary/10" disabled={reset.isPending} onClick={() => confirm('Start over with a fresh copy of the demo?') && reset.mutate()}>
              <RotateCcw aria-hidden />
              {reset.isPending ? 'Resetting…' : 'Reset demo'}
            </Button>
          )}
          <Link href="/orgs?pick=1" className="rounded-md px-2 py-1 text-xs font-medium underline-offset-4 hover:underline">
            Use your own repos
          </Link>
        </div>
      </div>
      {state.open && (
        <ol className="grid gap-px border-t border-primary/15 bg-primary/10 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => {
            const seen = state.seen.includes(s.path);
            return (
              <li key={s.path} className="bg-card">
                <Link href={`/o/${slug}${s.path}`} className="flex h-full gap-3 px-4 py-3 transition-colors hover:bg-secondary">
                  {seen ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      <span className="mr-1 tabular-nums text-muted-foreground">{i + 1}.</span>
                      {s.label}
                      <span className="sr-only">{seen ? ' (done)' : ''}</span>
                    </span>
                    <span className="block text-xs text-muted-foreground">{s.hint}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
