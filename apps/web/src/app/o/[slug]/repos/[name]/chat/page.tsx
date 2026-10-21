'use client';

import { Alert, Button, cn, Pending } from '@autodev/ui';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Markdown } from '@/components/markdown';
import { CodeIndexStatus } from '@/components/code-index-status';
import { Citations, MakeTaskButton } from '@/components/repo-chat-bits';
import { RepoNav } from '@/components/repo-nav';
import { trpc } from '@/lib/trpc';
import { useArrivals } from '@/lib/use-arrivals';
import { useEvents } from '@/lib/use-events';
import { useOrg } from '../../../org-shell';

/** Private questions about one repo. Answers come from the repo's code, read with your own GitHub access. */
export default function RepoChatPage() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  const org = useOrg();
  const router = useRouter();
  const search = useSearchParams();
  const utils = trpc.useUtils();
  const me = trpc.me.get.useQuery();
  const repo = trpc.repos.byName.useQuery({ name });
  const repoId = repo.data?.id ?? '';
  const chats = trpc.chat.list.useQuery({ repoId }, { enabled: !!repoId });
  const chatId = search.get('c') ?? chats.data?.[0]?.id ?? null;
  const thread = trpc.chat.messages.useQuery(
    { chatId: chatId ?? '' },
    // Answers arrive as chat.message events; the slow poll is only a safety net if the stream drops.
    { enabled: !!chatId, refetchInterval: (q) => (q.state.data?.messages.some((m) => m.status === 'pending') ? 15_000 : false) },
  );
  useEvents(org.orgId, me.data?.user ? [`user:${me.data.user.id}`] : [], (events) => {
    if (events.some((e) => e.type === 'chat.message')) {
      void utils.chat.messages.invalidate();
      void utils.chat.list.invalidate();
    }
  });
  const isNew = useArrivals(thread.data?.messages.map((m) => m.id), chatId ?? '');
  const [draft, setDraft] = useState('');
  const select = (id: string) => router.replace(`/o/${slug}/repos/${name}/chat?c=${id}`);

  const create = trpc.chat.create.useMutation({
    onSuccess: async (c) => {
      await utils.chat.list.invalidate({ repoId });
      select(c.id);
    },
  });
  const ask = trpc.chat.ask.useMutation({
    onSuccess: async () => {
      setDraft('');
      await Promise.all([utils.chat.messages.invalidate({ chatId: chatId ?? '' }), utils.chat.list.invalidate({ repoId })]);
    },
  });

  if (repo.error) return <Alert tone="destructive">{repo.error.message}</Alert>;
  if (!repo.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const r = repo.data;
  const pending = thread.data?.messages.some((m) => m.status === 'pending') ?? false;
  const canSend = !!chatId && draft.trim().length > 0 && !pending && !ask.isPending;

  return (
    <section className="space-y-4">
      <RepoNav slug={slug} name={name} fullName={r.fullName} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Ask the repo</h1>
          <p className="text-sm text-muted-foreground">Private to you. For questions the team should see, use the team room.</p>
          <CodeIndexStatus orgId={org.orgId} repoId={r.id} />
        </div>
        <Button onClick={() => create.mutate({ repoId })} disabled={create.isPending}>
          New chat
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <nav aria-label="Your chats" className="space-y-1">
          {chats.data?.length === 0 && <p className="text-sm text-muted-foreground">No chats yet. Start one to ask about this repo.</p>}
          {chats.data?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => select(c.id)}
              aria-current={c.id === chatId ? 'true' : undefined}
              className={cn('w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-muted', c.id === chatId && 'bg-muted font-medium')}
            >
              {c.title}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          {!chatId && <p className="text-sm text-muted-foreground">Start a chat to ask a question about {r.fullName}.</p>}
          {thread.error && <Alert tone="destructive">{thread.error.message}</Alert>}

          <ol className="space-y-6">
            {thread.data?.messages.map((m) =>
              m.role === 'user' ? (
                <li key={m.id} className={cn('ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg [overflow-wrap:anywhere] bg-muted px-4 py-2 text-sm', isNew(m.id) && 'animate-enter motion-reduce:animate-fade')}>
                  {m.content}
                </li>
              ) : (
                <li key={m.id} className={cn('space-y-2', isNew(m.id) && 'animate-enter motion-reduce:animate-fade')}>
                  {m.status === 'pending' && <Pending label="Reading the repository…" />}
                  {m.status === 'failed' && <Alert tone="destructive">{m.content}</Alert>}
                  {m.status === 'done' && (
                    <div className={cn('space-y-2', isNew(m.id) && 'animate-fade')}>
                      <Markdown text={m.content} />
                      <Citations htmlUrl={r.htmlUrl} sha={m.commitSha} citations={m.citations} />
                      {r.canCreate && <MakeTaskButton slug={slug} repoName={name} htmlUrl={r.htmlUrl} text={m.content} sha={m.commitSha} citations={m.citations} />}
                    </div>
                  )}
                </li>
              ),
            )}
          </ol>

          {chatId && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSend) ask.mutate({ chatId, question: draft });
              }}
            >
              {ask.error && <Alert tone="destructive">{ask.error.message}</Alert>}
              <textarea
                aria-label="Your question"
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="How is authentication handled? Where does the upload size limit live?"
                value={draft}
                maxLength={4000}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">Answers read the repo at its default branch, with your access.</p>
                <Button type="submit" disabled={!canSend}>
                  {pending ? 'Answering…' : 'Ask'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
