'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@autodev/ui';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Markdown } from '@/components/markdown';
import { RepoNav } from '@/components/repo-nav';
import { relativeTime } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useEvents } from '@/lib/use-events';
import { useOrg } from '../../../org-shell';

type Section = RouterOutputs['repoAgent']['memory']['get']['sections'][number];

const HINT: Record<Section['section'], string> = {
  conventions: 'Naming, file layout, libraries to use, how tests are written.',
  architecture: 'The main parts and how they talk to each other.',
  rules: 'Things that must always or never happen.',
  fragile_areas: 'Code to be careful with, and why.',
};

/** The Repo Agent's memory: what it should know about this repo beyond the code. */
export default function RepoAgentPage() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  const org = useOrg();
  const utils = trpc.useUtils();
  const repo = trpc.repos.byName.useQuery({ name });
  const repoId = repo.data?.id ?? '';
  const memory = trpc.repoAgent.memory.get.useQuery({ repoId }, { enabled: !!repoId });
  useEvents(org.orgId, repoId ? [`repo:${repoId}`] : [], (events) => {
    if (events.some((e) => e.type === 'repo_agent.memory_updated')) void utils.repoAgent.memory.get.invalidate({ repoId });
  });

  if (repo.error) return <Alert tone="destructive">{repo.error.message}</Alert>;
  if (!repo.data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <section className="space-y-4">
      <RepoNav slug={slug} name={name} fullName={repo.data.fullName} />
      <div>
        <h1 className="text-xl font-semibold">Repo Agent memory</h1>
        <p className="text-sm text-muted-foreground">
          The Repo Agent and private chat read these notes before answering. Keep them short and true; if a note disagrees with the code, the code
          wins. {memory.data && !memory.data.canEdit && 'People who can push to this repository, and admins, can edit them.'}
        </p>
      </div>
      {memory.error && <Alert tone="destructive">{memory.error.message}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        {memory.data?.sections.map((s) => (
          <MemoryCard key={s.section} repoId={repoId} section={s} canEdit={memory.data.canEdit} />
        ))}
      </div>
    </section>
  );
}

function MemoryCard({ repoId, section: s, canEdit }: { repoId: string; section: Section; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.contentMd);
  const save = trpc.repoAgent.memory.update.useMutation({
    onSuccess: async () => {
      setEditing(false);
      await utils.repoAgent.memory.get.invalidate({ repoId });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{s.title}</CardTitle>
        <CardDescription>{HINT[s.section]}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ repoId, section: s.section, contentMd: text });
            }}
          >
            <textarea
              aria-label={s.title}
              className="flex min-h-[160px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={text}
              maxLength={8000}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{text.length} / 8000 · Markdown</p>
            {save.error && <Alert tone="destructive">{save.error.message}</Alert>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={save.isPending}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText(s.contentMd);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            {s.contentMd.trim() ? <Markdown text={s.contentMd} /> : <p className="text-sm text-muted-foreground">Nothing yet.</p>}
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{s.updatedAt ? `Updated ${relativeTime(s.updatedAt)}${s.updatedBy ? ` by ${s.updatedBy}` : ''}` : ''}</p>
              {canEdit && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Edit ${s.title}`}
                  onClick={() => {
                    setText(s.contentMd);
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
