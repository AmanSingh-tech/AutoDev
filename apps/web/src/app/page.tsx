import { Button } from '@autodev/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { missingConfig } from '@/lib/config-check';

export const metadata: Metadata = {
  title: 'AutoDev: coding tasks done by an AI agent, as pull requests from you',
  description: 'Write a task, approve the plan, and AutoDev’s agent writes the code, runs your tests on your own machine and opens the pull request on GitHub as you.',
};

const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Tasks become pull requests',
    body: 'Describe a bug fix or a feature. The agent plans it, writes the code, runs your tests and opens a PR on GitHub, with you as the author.',
  },
  {
    title: 'You stay in control',
    body: 'Approve the plan and the design before any code is written, ask for changes at each step, and review the diff before it’s pushed.',
  },
  {
    title: 'Runs on your machines',
    body: 'A small builder program runs the commands and tests on a laptop or server you choose, so your code and secrets never sit on ours.',
  },
  {
    title: 'Your own AI keys',
    body: 'Use your Anthropic, OpenAI, Azure OpenAI or Amazon Bedrock account. Keys are encrypted, never shown again, and spend has budgets per person and team.',
  },
  {
    title: 'Ask your codebase',
    body: 'A private chat per repository answers with links to the exact files and lines, and a shared room keeps the team’s questions in one place.',
  },
  {
    title: 'A teammate that watches the repos',
    body: 'The Group Agent scans every repository for vulnerable or outdated dependencies and other risks, sends a weekly health digest, and can open draft fix PRs.',
  },
];

const STEPS: { title: string; body: string }[] = [
  { title: 'Sign in with GitHub', body: 'AutoDev only sees the repositories your GitHub account can push to, and acts on them as you.' },
  { title: 'Install the GitHub App', body: 'An admin installs it on your GitHub organization and picks which repositories it may use.' },
  { title: 'Add an AI key', body: 'Paste an API key under Settings → AI keys. It’s checked with a free test call, then stored encrypted.' },
  { title: 'Pair a builder', body: 'Run one command on the machine that should run your tests, and approve it in the browser.' },
  { title: 'Create a task', body: 'Pick a repository, describe the change (templates and a prompt checker help), and press Start.' },
  { title: 'Review and merge', body: 'Approve the plan, watch the agent work, check the diff and the test results, and merge the PR on GitHub.' },
];

const TRUST: string[] = [
  'Every organization’s data is kept apart in the database itself (row-level security).',
  'GitHub tokens and AI keys are encrypted at rest and only decrypted for the one call that needs them.',
  'Webhooks are signature-checked, and every important change is written to an append-only audit log.',
  'Enterprise controls: single sign-on, directory sync, IP allowlist, data retention, audit export to your SIEM.',
];

/**
 * The public home page: what AutoDev does and how to start. Signed-in people go straight to their
 * organizations; a deployment without its settings sends "Get started" to the setup page.
 */
export default async function Home() {
  const configured = missingConfig().length === 0;
  if (configured) {
    const session = await auth();
    if (session?.user?.id) redirect('/orgs');
  }
  const start = configured ? '/login' : '/setup/config';

  return (
    <div className="min-h-dvh">
      <header className="border-b pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold">AutoDev</span>
          <nav aria-label="Home" className="flex items-center gap-1 text-sm">
            <a href="#how" className="hidden rounded-md px-3 py-1.5 hover:bg-muted sm:inline">
              How it works
            </a>
            <a href="#start" className="hidden rounded-md px-3 py-1.5 hover:bg-muted sm:inline">
              Get started
            </a>
            <Button asChild size="sm">
              <Link href={start}>{configured ? 'Sign in' : 'Set up'}</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="pb-[calc(3rem+env(safe-area-inset-bottom))]">
        <section className="mx-auto max-w-5xl px-4 pb-12 pt-16 sm:pt-24">
          <p className="text-sm font-medium text-muted-foreground">For engineering teams on GitHub</p>
          <h1 className="mt-3 max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Hand off coding tasks. Get back pull requests you’d have written.
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-lg text-muted-foreground">
            AutoDev is an AI agent for your team. Write a task, approve its plan, and it writes the code, runs your tests on your own machine and opens the pull
            request on GitHub as you. You decide every step.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={start}>{configured ? 'Get started with GitHub' : 'Set up this server'}</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="#how">See how it works</a>
            </Button>
          </div>
          {!configured && (
            <p className="mt-4 text-sm text-muted-foreground">This server isn’t configured yet. The setup page lists the settings it still needs.</p>
          )}
        </section>

        <section aria-labelledby="what" className="border-t bg-muted/40">
          <div className="mx-auto max-w-5xl px-4 py-14">
            <h2 id="what" className="text-2xl font-semibold tracking-tight">
              What it does
            </h2>
            <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <li key={f.title} className="rounded-lg border bg-background p-5">
                  <h3 className="font-medium">{f.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="how-title" id="how" className="mx-auto max-w-5xl scroll-mt-16 px-4 py-14">
          <h2 id="how-title" className="text-2xl font-semibold tracking-tight">
            How a task works
          </h2>
          <ol className="mt-8 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Plan', 'The agent reads the code and proposes a plan. You approve it or ask for changes.'],
              ['Design', 'For bigger tasks it writes a short design first, which you approve the same way.'],
              ['Code and test', 'It edits the code on your builder and runs your tests, fixing failures up to a limit you set.'],
              ['Pull request', 'It pushes a branch and opens the PR as you, linked back to the task.'],
            ].map(([title, body], i) => (
              <li key={title} className="rounded-lg border p-5">
                <span className="text-xs font-medium tabular-nums text-muted-foreground">Step {i + 1}</span>
                <h3 className="mt-1 font-medium">{title}</h3>
                <p className="mt-2 text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-sm text-muted-foreground">Small changes can skip the plan and design (“direct mode”), and every mode can be stopped at any time.</p>
        </section>

        <section aria-labelledby="start-title" id="start" className="scroll-mt-16 border-t bg-muted/40">
          <div className="mx-auto max-w-5xl px-4 py-14">
            <h2 id="start-title" className="text-2xl font-semibold tracking-tight">
              Get started in six steps
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">After you sign in, a checklist in the app walks your admin through the setup and ticks each step off.</p>
            <ol className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-4">
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-sm font-medium tabular-nums">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="font-medium">{s.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-10">
              <Button asChild size="lg">
                <Link href={start}>{configured ? 'Sign in with GitHub' : 'Set up this server'}</Link>
              </Button>
            </div>
          </div>
        </section>

        <section aria-labelledby="trust" className="mx-auto max-w-5xl px-4 py-14">
          <h2 id="trust" className="text-2xl font-semibold tracking-tight">
            Built to be trusted with your code
          </h2>
          <ul className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
            {TRUST.map((t) => (
              <li key={t} className="flex gap-3">
                <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/60" />
                <span className="text-muted-foreground">{t}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground">
          <span>AutoDev</span>
          <Link href={start} className="hover:underline">
            {configured ? 'Sign in' : 'Set up this server'}
          </Link>
        </div>
      </footer>
    </div>
  );
}
