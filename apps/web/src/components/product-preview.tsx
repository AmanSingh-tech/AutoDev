import { cn } from '@autodev/ui';
import { Check, CircleCheck, FileText, GitPullRequest, Hand, Sparkles } from 'lucide-react';

/**
 * A still of the product for the home page, drawn with the app's own pieces (so it follows the
 * theme and stays sharp at any size): a task with its step tracker, the plan waiting for approval,
 * the change and a passing test run.
 */
export function ProductPreview({ className }: { className?: string }) {
  const steps = [
    { label: 'Plan', state: 'done' },
    { label: 'Design', state: 'done' },
    { label: 'Code', state: 'done' },
    { label: 'Tests', state: 'done' },
    { label: 'Pull request', state: 'active' },
  ] as const;
  return (
    <div className={cn('relative', className)} aria-hidden>
      <div className="pointer-events-none absolute -inset-x-10 -top-10 bottom-0 rounded-[2rem] bg-gradient-to-b from-primary/20 via-primary/5 to-transparent blur-2xl" />
      <div className="relative overflow-hidden rounded-xl border bg-card shadow-pop">
        <div className="flex items-center gap-1.5 border-b bg-secondary/50 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="ml-3 truncate rounded-md bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground">autodev.app/o/acme/tasks/ACME-42</span>
        </div>
        <div className="space-y-4 p-5 text-left">
          <div>
            <div className="font-mono text-[11px] text-muted-foreground">acme/api › ACME-42</div>
            <div className="mt-1 text-base font-semibold tracking-tight sm:text-lg">Return 404 instead of 500 for unknown organizations</div>
            <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
              <GitPullRequest className="size-3" /> PR open
            </span>
          </div>
          <ol className="flex gap-1 rounded-lg border p-1">
            {steps.map((s, i) => (
              <li key={s.label} className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px]', s.state === 'active' ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground')}>
                <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full text-[9px]', s.state === 'done' ? 'bg-primary text-primary-foreground' : 'border border-primary text-primary')}>
                  {s.state === 'done' ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className="truncate">{s.label}</span>
              </li>
            ))}
          </ol>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <FileText className="size-3.5" /> Plan · approved by Priya
              </div>
              <ul className="mt-2 space-y-1.5 text-[11px] leading-snug">
                <li>1. Look the org up before loading it in <code className="font-mono">orgs.ts</code></li>
                <li>2. Return 404 with <code className="font-mono">not_found</code></li>
                <li>3. Add tests for the missing and archived cases</li>
              </ul>
            </div>
            <div className="overflow-hidden rounded-lg border font-mono text-[10.5px] leading-[1.55]">
              <div className="border-b bg-secondary/50 px-3 py-1.5 text-[11px] text-muted-foreground">src/routes/orgs.ts</div>
              <div className="px-3 py-1.5">
                <div className="text-muted-foreground">  const org = await findOrg(slug);</div>
                <div className="bg-destructive/10 text-destructive">- return reply.send(org.profile);</div>
                <div className="bg-success/10 text-success">+ if (!org) return reply.code(404)</div>
                <div className="bg-success/10 text-success">+   .send({'{'} error: &apos;not_found&apos; {'}'});</div>
                <div className="bg-success/10 text-success">+ return reply.send(org.profile);</div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-secondary/40 px-3 py-2 text-[11px]">
            <span className="flex items-center gap-1.5 font-medium text-success">
              <CircleCheck className="size-3.5" /> 42 tests passed on your builder
            </span>
            <span className="text-muted-foreground">18s · Docker · node 20</span>
            <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
              <Sparkles className="size-3.5 text-primary" /> $0.38
            </span>
          </div>
        </div>
      </div>
      <div className="absolute -bottom-12 -left-4 hidden w-60 rounded-xl border bg-popover p-3 shadow-pop sm:block lg:-left-10">
        <div className="flex items-start gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-warning/15 text-warning">
            <Hand className="size-3.5" />
          </span>
          <div className="text-[11px] leading-snug">
            <div className="font-medium">Design ready for review</div>
            <div className="text-muted-foreground">ACME-43 · Add rate limiting to the public API</div>
          </div>
        </div>
      </div>
    </div>
  );
}
