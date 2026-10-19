'use client';

import { Alert, Button, cn } from '@autodev/ui';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Markdown } from '@/components/markdown';
import { trpc } from '@/lib/trpc';

/** Ask questions about one repo. Answers come from the repo's code, read with your own GitHub access. */
export default function RepoChatPage() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const utils = trpc.useUtils();
  const repo = trpc.repos.byName.useQuery({ name });
  const repoId = repo.data?.id ?? '';
  const chats = trpc.chat.list.useQuery({ repoId }, { enabled: !!repoId });
  const chatId = search.get('c') ?? chats.data?.[0]?.id ?? null;
  const thread = trpc.chat.messages.useQuery(
    { chatId: chatId ?? '' },
    {
      enabled: !!chatId,
      // Answers arrive from the worker. Poll while one is pending; realtime doesn't cover chats yet.
      refetchInterval: (q) =>
        q.state.data?.messages.some((m) => m.status === 'pending') ? 2000 : false,
    },
  );
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
      await Promise.all([
        utils.chat.messages.invalidate({ chatId: chatId ?? '' }),
        utils.chat.list.invalidate({ repoId }),
      ]);
    },
  });

  if (repo.error) return <Alert tone="destructive">{repo.error.message}</Alert>;
  if (!repo.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const pending = thread.data?.messages.some((m) => m.status === 'pending') ?? false;
  const canSend = !!chatId && draft.trim().length > 0 && !pending && !ask.isPending;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href={`/o/${slug}/repos/${name}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            ← {repo.data.fullName}
          </Link>
          <h1 className="text-xl font-semibold">Ask the repo</h1>
        </div>
        <Button onClick={() => create.mutate({ repoId })} disabled={create.isPending}>
          New chat
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <nav aria-label="Your chats" className="space-y-1">
          {chats.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No chats yet. Start one to ask about this repo.
            </p>
          )}
          {chats.data?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => select(c.id)}
              aria-current={c.id === chatId ? 'true' : undefined}
              className={cn(
                'w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-muted',
                c.id === chatId && 'bg-muted font-medium',
              )}
            >
              {c.title}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          {!chatId && (
            <p className="text-sm text-muted-foreground">
              Start a chat to ask a question about {repo.data.fullName}.
            </p>
          )}
          {thread.error && <Alert tone="destructive">{thread.error.message}</Alert>}

          <ol className="space-y-6">
            {thread.data?.messages.map((m) =>
              m.role === 'user' ? (
                <li
                  key={m.id}
                  className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-4 py-2 text-sm"
                >
                  {m.content}
                </li>
              ) : (
                <li key={m.id} className="space-y-2">
                  {m.status === 'pending' && (
                    <p className="text-sm text-muted-foreground">Reading the repository…</p>
                  )}
                  {m.status === 'failed' && <Alert tone="destructive">{m.content}</Alert>}
                  {m.status === 'done' && <Markdown text={m.content} />}
                  {m.status === 'done' && m.sources.length > 0 && (
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>Read:</span>
                      {m.sources.map((path) => (
                        <a
                          key={path}
                          href={`https://github.com/${repo.data.fullName}/blob/${repo.data.defaultBranch}/${path}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded border px-1.5 py-0.5 font-mono hover:underline"
                        >
                          {path}
                        </a>
                      ))}
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
                <p className="text-xs text-muted-foreground">
                  Answers read the repo at its default branch, with your access.
                </p>
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
