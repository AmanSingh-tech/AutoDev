'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from '@autodev/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';

type StepId = 'github' | 'ai_key' | 'models' | 'team' | 'builder' | 'plan';

const STEPS: Record<StepId, { title: string; hint: string; href: string; action: string; skip?: { label: string; flag: 'modelsConfirmed' | 'inviteSkipped' } }> = {
  github: { title: 'Install the GitHub App', hint: 'AutoDev sees the repositories you choose, and nothing else.', href: '/orgs', action: 'Install' },
  ai_key: { title: 'Add an AI key', hint: 'Agents run on your own Anthropic key. It’s encrypted and never leaves the server.', href: '/settings/ai-keys', action: 'Add a key' },
  models: {
    title: 'Check the models',
    hint: 'Which model each kind of work uses, and the token caps per task. The defaults suit most teams.',
    href: '/settings/models',
    action: 'Review',
    skip: { label: 'Defaults are fine', flag: 'modelsConfirmed' },
  },
  team: { title: 'Bring your team', hint: 'Teammates join by signing in with GitHub; their repo access follows GitHub.', href: '/members', action: 'Invite', skip: { label: 'Just me for now', flag: 'inviteSkipped' } },
  builder: { title: 'Pair a builder', hint: 'A builder runs the agent’s commands and tests on a machine you control.', href: '/builders', action: 'Pair' },
  plan: { title: 'Choose a plan', hint: 'Per seat. Everything works during the free trial.', href: '/settings/billing', action: 'See plans' },
};

/** The first-run checklist. Steps tick themselves off from the org's data; two can be skipped. */
export default function OnboardingPage() {
  const { slug } = useParams<{ slug: string }>();
  const utils = trpc.useUtils();
  const status = trpc.onboarding.status.useQuery();
  const update = trpc.onboarding.update.useMutation({
    onSuccess: () => void utils.onboarding.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  if (!status.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { steps, complete, dismissed, isAdmin } = status.data;
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Set up AutoDev</h1>
        <p className="text-sm text-muted-foreground">
          {complete ? 'All set. Create a task from any repository to start.' : `${done} of ${steps.length} done.`}
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label="Setup progress">
          <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
      </div>
      {!isAdmin && <Alert>Only owners and admins can finish these steps.</Alert>}
      <ol className="space-y-3">
        {steps.map((s, i) => {
          const step = STEPS[s.id as StepId];
          const href = step.href.startsWith('/orgs') ? step.href : `/o/${slug}${step.href}`;
          return (
            <li key={s.id}>
              <Card className={cn(s.id === next && 'border-primary/60')}>
                <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                  <span
                    aria-hidden
                    className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums', s.done && 'border-transparent bg-primary text-primary-foreground')}
                  >
                    {s.done ? '✓' : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <CardTitle className={cn('text-base', s.done && 'text-muted-foreground line-through decoration-1')}>
                      {step.title}
                      <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
                    </CardTitle>
                    <CardDescription>{step.hint}</CardDescription>
                  </div>
                </CardHeader>
                {!s.done && isAdmin && (
                  <CardContent className="flex flex-wrap gap-2 pl-[3.25rem]">
                    <Button size="sm" variant={s.id === next ? 'default' : 'outline'} asChild>
                      <Link href={href}>{step.action}</Link>
                    </Button>
                    {step.skip && (
                      <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ [step.skip!.flag]: true })}>
                        {step.skip.label}
                      </Button>
                    )}
                  </CardContent>
                )}
              </Card>
            </li>
          );
        })}
      </ol>
      {isAdmin && !complete && !dismissed && (
        <Button variant="ghost" size="sm" onClick={() => update.mutate({ dismissed: true }, { onSuccess: () => toast('The setup reminder is hidden. This page stays at /onboarding.') })}>
          Hide the setup reminder
        </Button>
      )}
    </div>
  );
}
