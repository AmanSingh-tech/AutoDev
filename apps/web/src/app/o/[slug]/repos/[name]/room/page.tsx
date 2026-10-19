'use client';

import { Alert, Avatar, Button, cn, Pending } from '@autodev/ui';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Citations, MakeTaskButton } from '@/components/repo-chat-bits';
import { RepoNav } from '@/components/repo-nav';
import { relativeTime } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import { useArrivals } from '@/lib/use-arrivals';
import { useEvents } from '@/lib/use-events';
import { useOrg } from '../../../org-shell';

/** The repo's shared team room. Mention @agent to have the Repo Agent answer from the code. */
export default function TeamRoomPage() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  const org = useOrg();
  const utils = trpc.useUtils();
  const repo = trpc.repos.byName.useQuery({ name });
  const repoId = repo.data?.id ?? '';
  const room = trpc.room.get.useQuery({ repoId }, { enabled: !!repoId });
  useEvents(org.orgId, repoId ? [`repo:${repoId}`] : [], (events) => {
    if (events.some((e) => e.type === 'channel.message')) void utils.room.get.invalidate({ repoId });
  });
  const isNew = useArrivals(room.data?.messages.map((m) => m.id), repoId);
  const [draft, setDraft] = useState('');
  const post = trpc.room.post.useMutation({
    onSuccess: async () => {
      setDraft('');
      await utils.room.get.invalidate({ repoId });
    },
  });

  // Keep the newest message in view as the room grows.
  const end = useRef<HTMLDivElement>(null);
  const count = room.data?.messages.length ?? 0;
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [count]);

  if (repo.error) return <Alert tone="destructive">{repo.error.message}</Alert>;
  if (!repo.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const r = repo.data;
  const send = () => draft.trim() && !post.isPending && post.mutate({ repoId, content: draft });

  return (
    <section className="space-y-4">
      <RepoNav slug={slug} name={name} fullName={r.fullName} />
      <div>
        <h1 className="text-xl font-semibold">Team room</h1>
        <p className="text-sm text-muted-foreground">
          Everyone with access to {r.fullName} sees this room. Mention <span className="font-mono">@agent</span> to ask the Repo Agent; it answers with
          your access and your AI budget.
        </p>
      </div>

      {room.error && <Alert tone="destructive">{room.error.message}</Alert>}
      <ol className="space-y-5" aria-label="Messages">
        {room.data?.messages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet. Say hello, or ask @agent about the code.</p>}
        {room.data?.messages.map((m) => (
          <li key={m.id} className={cn('flex gap-3', isNew(m.id) && 'animate-enter motion-reduce:animate-fade')}>
            {m.author === 'agent' ? (
              <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                AI
              </span>
            ) : (
              <Avatar src={m.avatarUrl} alt={m.login} className="h-7 w-7" />
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{m.author === 'agent' ? 'Repo Agent' : m.login}</span>
                {m.author === 'agent' && <span> · asked by {m.login}</span>} · {relativeTime(m.createdAt)}
              </p>
              {m.status === 'pending' && <Pending label="Reading the repository…" />}
              {m.status === 'failed' && <Alert tone="destructive">{m.content}</Alert>}
              {m.status === 'done' &&
                (m.author === 'agent' ? <Markdown text={m.content} /> : <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{m.content}</p>)}
              {m.status === 'done' && <Citations htmlUrl={r.htmlUrl} sha={m.commitSha} citations={m.citations} />}
              {m.status === 'done' && r.canCreate && (
                <MakeTaskButton slug={slug} repoName={name} htmlUrl={r.htmlUrl} text={m.content} sha={m.commitSha} citations={m.citations} />
              )}
            </div>
          </li>
        ))}
      </ol>
      <div ref={end} />

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {post.error && <Alert tone="destructive">{post.error.message}</Alert>}
        <textarea
          aria-label="Message"
          className="flex min-h-[70px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Message the team. @agent where is the retry logic?"
          value={draft}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Ctrl+Enter to send.</p>
          <Button type="submit" disabled={!draft.trim() || post.isPending}>
            Send
          </Button>
        </div>
      </form>
    </section>
  );
}
