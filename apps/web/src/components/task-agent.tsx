'use client';

import { Alert, Badge, Button, cn, NativeSelect } from '@autodev/ui';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { relativeTime, tokens, usd } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ConfigCommands } from './commands';
import { Markdown } from './markdown';

// Monaco is large: load it only when a document's source or a diff is opened.
const MarkdownSource = dynamic(() => import('./monaco').then((m) => m.MarkdownSource), { ssr: false, loading: () => <Loading /> });
const FileDiff = dynamic(() => import('./monaco').then((m) => m.FileDiff), { ssr: false, loading: () => <Loading /> });
const Loading = () => <p className="p-4 text-sm text-muted-foreground">Loading editor…</p>;

type Task = RouterOutputs['tasks']['get'];
type Doc = RouterOutputs['agent']['documents']['docs'][number];
const textarea = 'flex min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function useRefresh(key: string) {
  const utils = trpc.useUtils();
  return () => Promise.all([utils.tasks.get.invalidate({ key }), utils.agent.documents.invalidate({ key }), utils.agent.activity.invalidate({ key }), utils.tasks.list.invalidate()]);
}

const canAct = (t: Task) => t.can.cancel || t.can.start || t.can.edit;

/** What the task needs from a person right now: a review, an answer, or a key. */
export function AttentionPanel({ task: t }: { task: Task }) {
  const docs = trpc.agent.documents.useQuery({ key: t.key }, { refetchInterval: 60_000 });
  if (t.status === 'awaiting_plan_approval' || t.status === 'awaiting_lld_approval') {
    const kind = t.status === 'awaiting_plan_approval' ? 'plan' : 'lld';
    const pending = docs.data?.docs.find((d) => d.kind === kind && d.status === 'pending_review');
    return pending ? <ReviewPanel task={t} doc={pending} /> : null;
  }
  if (t.status === 'needs_input' && docs.data?.question) return <QuestionPanel task={t} question={docs.data.question} />;
  if (t.status === 'blocked_on_key') return <BlockedPanel task={t} />;
  if (t.status === 'waiting_for_builder') return <WaitingForBuilder task={t} />;
  if (t.status === 'testing') return <TestingPanel task={t} />;
  if (t.status === 'pushed' || t.status === 'pr_open' || t.status === 'resolved') return <PrPanel task={t} />;
  if (t.status === 'failed' && t.failure) return <FailurePanel task={t} />;
  if (['planning', 'designing', 'coding', 'fixing'].includes(t.status)) return <Alert>The agent is working on this task. This page refreshes on its own.</Alert>;
  return null;
}

function ReviewPanel({ task: t, doc }: { task: Task; doc: Doc }) {
  const refresh = useRefresh(t.key);
  const [mode, setMode] = useState<'idle' | 'changes'>('idle');
  const [comment, setComment] = useState('');
  const review = trpc.agent.review.useMutation({ onSuccess: refresh });
  const label = doc.kind === 'plan' ? 'Plan' : 'Low-level design';
  const can = canAct(t);
  return (
    <section className="space-y-4 rounded-lg border-2 border-viz-accent/60 bg-card p-4" aria-label={`${label} review`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {label} v{doc.version} is ready for your review
        </h2>
        <span className="text-xs text-muted-foreground">{relativeTime(doc.createdAt)}</span>
      </div>
      <DocumentView doc={doc} />
      {can ? (
        mode === 'changes' ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              review.mutate({ key: t.key, kind: doc.kind, version: doc.version, decision: 'request_changes', comment });
            }}
          >
            <label htmlFor="review-comment" className="text-sm font-medium">
              What should change?
            </label>
            <textarea id="review-comment" className={textarea} value={comment} onChange={(e) => setComment(e.target.value)} required />
            <div className="flex gap-2">
              <Button type="submit" disabled={review.isPending || !comment.trim()}>
                Send to the agent for v{doc.version + 1}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setMode('idle')}>
                Back
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => review.mutate({ key: t.key, kind: doc.kind, version: doc.version, decision: 'approve' })} disabled={review.isPending}>
              Approve {doc.kind === 'plan' ? 'plan' : 'design'}
            </Button>
            <Button variant="outline" onClick={() => setMode('changes')}>
              Request changes
            </Button>
            <Button
              variant="ghost"
              onClick={() => confirm(`Reject this ${doc.kind === 'plan' ? 'plan' : 'design'}? The task will end.`) && review.mutate({ key: t.key, kind: doc.kind, version: doc.version, decision: 'reject' })}
              disabled={review.isPending}
            >
              Reject
            </Button>
          </div>
        )
      ) : (
        <p className="text-sm text-muted-foreground">The task owner or an admin reviews this.</p>
      )}
      {review.error && <Alert tone="destructive">{review.error.message}</Alert>}
    </section>
  );
}

function QuestionPanel({ task: t, question: q }: { task: Task; question: NonNullable<RouterOutputs['agent']['documents']['question']> }) {
  const refresh = useRefresh(t.key);
  const [answer, setAnswer] = useState('');
  const send = trpc.agent.answer.useMutation({ onSuccess: refresh });
  const deviation = q.kind === 'deviation';
  return (
    <section className="space-y-3 rounded-lg border-2 border-status-warning bg-card p-4" aria-label="Question from the agent">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <span aria-hidden>{deviation ? '⚠️' : '💬'}</span>
        {deviation ? 'The agent wants to go beyond the approved design' : 'The agent has a question'}
      </h2>
      <Markdown text={q.questionMd} />
      {deviation && q.paths.length > 0 && (
        <div className="text-sm">
          Files it wants to change:
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {q.paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {canAct(t) ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!deviation) send.mutate({ key: t.key, questionId: q.id, answer });
          }}
        >
          <label htmlFor="answer" className="text-sm font-medium">
            {deviation ? 'Note for the agent' : 'Your answer'}
          </label>
          <textarea id="answer" className={textarea} value={answer} onChange={(e) => setAnswer(e.target.value)} required={!deviation} />
          <div className="flex flex-wrap gap-2">
            {deviation ? (
              <>
                <Button type="button" disabled={send.isPending} onClick={() => send.mutate({ key: t.key, questionId: q.id, answer: answer || 'Approved.', approve: true })}>
                  Allow these changes
                </Button>
                <Button type="button" variant="outline" disabled={send.isPending} onClick={() => send.mutate({ key: t.key, questionId: q.id, answer: answer || 'Not approved.', approve: false })}>
                  Don’t allow
                </Button>
              </>
            ) : (
              <Button type="submit" disabled={send.isPending || !answer.trim()}>
                Send answer
              </Button>
            )}
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">The task owner or an admin answers this.</p>
      )}
      {send.error && <Alert tone="destructive">{send.error.message}</Alert>}
    </section>
  );
}

function BlockedPanel({ task: t }: { task: Task }) {
  const refresh = useRefresh(t.key);
  const resume = trpc.agent.resume.useMutation({ onSuccess: refresh });
  return (
    <Alert tone="destructive" className="space-y-2">
      <p>
        <span aria-hidden>⛔ </span>The LLM key stopped working, so the agent paused. Nothing is lost: it continues where it stopped once a working key exists
        (that happens automatically when an admin adds one).
      </p>
      {canAct(t) && (
        <Button size="sm" variant="outline" onClick={() => resume.mutate({ key: t.key })} disabled={resume.isPending}>
          Try again
        </Button>
      )}
      {resume.error && <p className="text-sm">{resume.error.message}</p>}
    </Alert>
  );
}

function DocumentView({ doc }: { doc: Doc }) {
  const [source, setSource] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setSource(!source)}>
          {source ? 'Show formatted' : 'Show markdown source'}
        </button>
      </div>
      <div className="max-h-[560px] overflow-y-auto rounded-md border bg-background p-4">{source ? <MarkdownSource value={doc.contentMd} /> : <Markdown text={doc.contentMd} />}</div>
    </div>
  );
}

const DOC_STATUS: Record<Doc['status'], string> = { pending_review: 'Waiting for review', approved: '✓ Approved', changes_requested: 'Changes requested', rejected: '✕ Rejected', superseded: 'Superseded' };

/** All versions of the plan and LLD, newest first, with the review on each. */
export function DocumentsSection({ task: t }: { task: Task }) {
  const docs = trpc.agent.documents.useQuery({ key: t.key });
  const [kind, setKind] = useState<'plan' | 'lld'>('plan');
  const list = docs.data?.docs.filter((d) => d.kind === kind) ?? [];
  const [version, setVersion] = useState<number | null>(null);
  const current = list.find((d) => d.version === version) ?? list[0];
  if (!docs.data?.docs.length) return null;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Documents</h2>
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Document">
          {(['plan', 'lld'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => (setKind(k), setVersion(null))} className={cn('rounded px-3 py-1 text-sm', kind === k && 'bg-muted font-medium')}>
              {k === 'plan' ? 'Plan' : 'Design (LLD)'}
            </button>
          ))}
        </div>
        {list.length > 1 && (
          <NativeSelect aria-label="Version" className="h-8 w-28" value={current?.version} onChange={(e) => setVersion(Number(e.target.value))}>
            {list.map((d) => (
              <option key={d.version} value={d.version}>
                v{d.version}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>
      {current ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={current.status === 'approved' ? 'outline' : 'secondary'}>{DOC_STATUS[current.status]}</Badge>
            {current.reviewerLogin && <span>by {current.reviewerLogin}</span>}
            {current.reviewedAt && <span>{relativeTime(current.reviewedAt)}</span>}
          </div>
          {current.comment && (
            <blockquote className="border-l-2 pl-3 text-sm">
              <span className="text-muted-foreground">Review comment: </span>
              {current.comment}
            </blockquote>
          )}
          <DocumentView doc={current} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No {kind === 'plan' ? 'plan' : 'design'} yet.</p>
      )}
    </section>
  );
}

/** Files the agent changed, with a side-by-side diff (Monaco). */
export function ChangesSection({ task: t }: { task: Task }) {
  const changes = trpc.agent.changes.useQuery({ key: t.key }, { refetchInterval: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  const diff = trpc.agent.fileDiff.useQuery({ key: t.key, path: open ?? '' }, { enabled: !!open });
  if (!changes.data?.files.length) return null;
  const OP = { create: 'added', modify: 'modified', delete: 'deleted' } as const;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        Changes ({changes.data.files.length} file{changes.data.files.length === 1 ? '' : 's'}) on top of <span className="font-mono">{changes.data.baseSha?.slice(0, 10)}</span>
      </h2>
      <ul className="divide-y rounded-md border text-sm">
        {changes.data.files.map((f) => (
          <li key={f.path}>
            <button type="button" className={cn('flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50', open === f.path && 'bg-muted/50')} onClick={() => setOpen(open === f.path ? null : f.path)} aria-expanded={open === f.path}>
              <span className="break-all font-mono text-xs">{f.path}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{OP[f.op]}</span>
            </button>
            {open === f.path && (
              <div className="border-t">
                {diff.error ? <Alert tone="destructive">{diff.error.message}</Alert> : diff.data ? <FileDiff path={f.path} before={diff.data.before} after={diff.data.after} /> : <Loading />}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const PHASE = { plan: 'Planning', lld: 'Design', code: 'Coding', fix: 'Fixing' } as const;

/** Runs and tool calls, newest first. Truncated; the full transcript stays on the server. */
export function ActivitySection({ task: t }: { task: Task }) {
  const q = trpc.agent.activity.useQuery({ key: t.key }, { refetchInterval: 60_000 });
  const [expanded, setExpanded] = useState(false);
  if (!q.data?.runs.length) return null;
  const steps = q.data.steps.filter((s) => s.kind === 'tool_call');
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">Agent runs</h2>
      <ul className="space-y-1 text-sm">
        {q.data.runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{PHASE[r.phase]}</span>
            <Badge variant={r.status === 'failed' ? 'destructive' : 'outline'}>{r.status}</Badge>
            <span className="text-muted-foreground">
              {r.turns} steps · {tokens(Number(r.inputTokens))} in / {tokens(Number(r.outputTokens))} out · {usd(r.costUsd)}
            </span>
            {r.error && <span className="text-xs text-destructive">{r.error}</span>}
          </li>
        ))}
      </ul>
      <button type="button" className="text-xs underline" onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Hide tool calls' : `Show ${steps.length} tool calls`}
      </button>
      {expanded && (
        <ol className="max-h-96 space-y-1 overflow-y-auto rounded-md border p-2 font-mono text-xs">
          {steps.map((s) => (
            <li key={s.id} className={cn('break-all', s.isError && 'text-destructive')}>
              <span className="font-semibold">{s.toolName}</span> {summarize(s.input)}
              {s.isError && <span> ✕ {s.output?.slice(0, 200)}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function summarize(input: unknown) {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  return String(o.path ?? o.pattern ?? o.question ?? o.reason ?? o.summary ?? '').slice(0, 160);
}

/** Where the change is on GitHub: the PR (open, merged, closed), or the branch with a Create PR button. */
function PrPanel({ task: t }: { task: Task }) {
  const refresh = useRefresh(t.key);
  const create = trpc.agent.createPr.useMutation({ onSuccess: refresh });
  const pr = t.pullRequests[0];
  if (pr) {
    const label = pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed without merging' : 'open';
    return (
      <Alert className="flex flex-wrap items-center justify-between gap-3">
        <span>
          <span aria-hidden>{pr.state === 'merged' ? '✓ ' : ''}</span>
          Pull request #{pr.number} is {label}
          {pr.state === 'merged' ? ', so this task is resolved.' : pr.state === 'open' ? ` against ${pr.baseBranch}.` : '.'}
        </span>
        <Button asChild size="sm" variant={pr.state === 'open' ? 'default' : 'outline'}>
          <a href={pr.url} target="_blank" rel="noopener noreferrer">
            Open PR #{pr.number} on GitHub
          </a>
        </Button>
      </Alert>
    );
  }
  return (
    <Alert className="space-y-2">
      <p>
        <span aria-hidden>✓ </span>Pushed to <span className="font-mono">{t.workBranch}</span>
        {t.lastPushedSha && <span className="font-mono text-muted-foreground"> ({t.lastPushedSha.slice(0, 7)})</span>}. No pull request yet.
      </p>
      {t.can.createPr && (
        <Button size="sm" onClick={() => create.mutate({ key: t.key })} disabled={create.isPending}>
          {create.isPending ? 'Opening…' : 'Create PR'}
        </Button>
      )}
      {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
    </Alert>
  );
}

function FailurePanel({ task: t }: { task: Task }) {
  const refresh = useRefresh(t.key);
  const retry = trpc.agent.retryPush.useMutation({ onSuccess: refresh });
  const f = t.failure!;
  return (
    <Alert tone="destructive" className="space-y-2">
      <p>
        <span aria-hidden>⛔ </span>
        {f.reason === 'push_failed' ? 'The change passed its tests but couldn’t be pushed: ' : 'The task failed: '}
        {f.message ?? f.reason ?? 'unknown reason'}
      </p>
      {t.can.retryPush && (
        <Button size="sm" variant="outline" onClick={() => retry.mutate({ key: t.key })} disabled={retry.isPending}>
          {retry.isPending ? 'Pushing…' : 'Retry push'}
        </Button>
      )}
      {retry.error && <p className="text-sm">{retry.error.message}</p>}
    </Alert>
  );
}

function TestingPanel({ task: t }: { task: Task }) {
  const jobs = trpc.agent.testJobs.useQuery({ key: t.key }, { refetchInterval: 60_000 });
  const last = jobs.data?.[0];
  if (last?.final && (last.status === 'passed' || last.status === 'skipped')) {
    return (
      <Alert>
        <span aria-hidden>✓ </span>
        {last.status === 'passed' ? 'Tests passed on your builder.' : 'No .autodev.yml on the base branch, so no tests were run.'} Pushing the change…
      </Alert>
    );
  }
  return <Alert>Your builder is running the tests. The log below updates live.</Alert>;
}

/** Why a test run hasn't started yet, and what to do about it. */
function WaitingForBuilder({ task: t }: { task: Task }) {
  const { slug } = useParams<{ slug: string }>();
  const jobs = trpc.agent.testJobs.useQuery({ key: t.key }, { refetchInterval: 60_000 });
  const builders = trpc.builders.list.useQuery(undefined, { refetchInterval: 10_000 });
  const pending = trpc.builders.pendingConfirmations.useQuery(undefined, { refetchInterval: 10_000 });
  const job = jobs.data?.[0];
  const refresh = useRefresh(t.key);
  const consent = trpc.agent.consent.useMutation({ onSuccess: refresh });
  if (job?.consent === 'pending') {
    return (
      <section className="space-y-3 rounded-lg border-2 border-status-warning bg-card p-4" aria-label="Test run consent">
        <h2 className="text-base font-semibold"><span aria-hidden>⚠️ </span>The change edits .autodev.yml</h2>
        <p className="text-sm">
          The agent changed your test configuration. Tests always run the <span className="font-medium">base branch’s</span> commands below, but the
          patched files are on disk during the run. Review the .autodev.yml change under “Changes” before allowing it.
        </p>
        <ConfigCommands config={job.config} />
        {canAct(t) && (
          <div className="flex gap-2">
            <Button onClick={() => consent.mutate({ key: t.key, jobId: job.id, allow: true })} disabled={consent.isPending}>Allow the test run</Button>
            <Button variant="outline" onClick={() => consent.mutate({ key: t.key, jobId: job.id, allow: false })} disabled={consent.isPending}>Don’t allow</Button>
          </div>
        )}
      </section>
    );
  }
  const mineOnline = builders.data?.some((b) => b.mine && b.online);
  const needsConfirm = pending.data?.length;
  return (
    <Alert className="space-y-1">
      <p className="font-medium">Waiting for your builder</p>
      {needsConfirm ? (
        <p>Your builder needs your OK for its first run in this repository. <Link className="underline" href={`/o/${slug}/builders`}>Review the commands</Link>.</p>
      ) : mineOnline ? (
        <p>Your builder is online; the run starts in a moment.</p>
      ) : builders.data?.some((b) => b.mine) ? (
        <p>Your builder is offline. Run <code className="font-mono">autodev start</code> on your machine; the tests run as soon as it connects.</p>
      ) : (
        <p>You don’t have a builder yet. <Link className="underline" href={`/o/${slug}/builders`}>Set one up</Link> to run tests on your machine.</p>
      )}
    </Alert>
  );
}

const JOB_STATUS: Record<string, string> = { queued: 'Queued', offered: 'Starting', running: 'Running', passed: '✓ Passed', failed: '✕ Failed', timed_out: '✕ Timed out', error: '✕ Could not run', skipped: 'Skipped (no .autodev.yml)', cancelled: 'Cancelled' };

/** Every test run for the task, with failing tests and the log. */
export function TestsSection({ task: t }: { task: Task }) {
  const jobs = trpc.agent.testJobs.useQuery({ key: t.key }, { refetchInterval: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  if (!jobs.data?.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">Test runs</h2>
      <ul className="divide-y rounded-md border text-sm">
        {jobs.data.map((j) => (
          <li key={j.id} className="space-y-2 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={j.status === 'failed' || j.status === 'timed_out' || j.status === 'error' ? 'destructive' : 'outline'}>{JOB_STATUS[j.status] ?? j.status}</Badge>
                <span className="text-muted-foreground">
                  {j.fixCycle > 0 ? `Fix attempt ${j.fixCycle}` : j.final ? 'Final check' : 'Mid-way check'}
                  {j.builderName ? ` · on ${j.builderName}` : ''}
                  {j.durationMs ? ` · ${Math.round(j.durationMs / 1000)}s` : ''}
                  {j.failedStep && j.status !== 'passed' ? ` · ${j.failedStep} step${j.exitCode !== null ? `, exit ${j.exitCode}` : ''}` : ''}
                </span>
              </span>
              {['running', 'passed', 'failed', 'timed_out', 'error'].includes(j.status) && (
                <button type="button" className="text-xs underline" onClick={() => setOpen(open === j.id ? null : j.id)}>
                  {open === j.id ? 'Hide log' : 'Show log'}
                </button>
              )}
            </div>
            {j.configError && <p className="text-xs text-destructive">{j.configError}</p>}
            {j.failedTests.length > 0 && (
              <ul className="list-disc pl-5 font-mono text-xs">
                {j.failedTests.slice(0, 20).map((ft, i) => (
                  <li key={i}>{ft.file ? `${ft.file}: ` : ''}{ft.name}</li>
                ))}
              </ul>
            )}
            {open === j.id && <JobLog jobId={j.id} running={j.status === 'running'} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function JobLog({ jobId, running }: { jobId: string; running: boolean }) {
  const q = trpc.agent.jobLog.useQuery({ jobId }, { refetchInterval: running ? 2000 : false });
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs leading-relaxed" aria-live={running ? 'polite' : undefined}>
      {q.data?.text || (q.isLoading ? 'Loading…' : 'No output yet.')}
    </pre>
  );
}
