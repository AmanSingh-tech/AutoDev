'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, NativeSelect } from '@autodev/ui';
import { useState } from 'react';
import { toast } from 'sonner';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Link = RouterOutputs['repoLinks']['list']['links'][number];
const TEXTAREA = 'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const MAX_NOTES = 8000;

/** Cross-repo sync (B-3): which repos' changes can be applied to which. */
export default function LinksPage() {
  const links = trpc.repoLinks.list.useQuery();
  if (links.error) return <Alert tone="destructive">{links.error.message}</Alert>;
  if (!links.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { canEdit } = links.data;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Linked repositories</h1>
        <p className="text-sm text-muted-foreground">
          A finished task in a source repository can be applied to its linked repository: AutoDev creates a draft task there with the change attached, and the agent
          ports it. Two-way links work in both directions.
        </p>
      </div>
      {!canEdit && <Alert>Only admins can change links.</Alert>}
      {canEdit && <NewLink />}
      {links.data.links.length === 0 ? (
        <p className="text-sm text-muted-foreground">No linked repositories yet.</p>
      ) : (
        <ul className="space-y-4" aria-label="Links">
          {links.data.links.map((l) => (
            <LinkCard key={l.id} link={l} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NewLink() {
  const utils = trpc.useUtils();
  const repos = trpc.repos.list.useQuery();
  const [form, setForm] = useState({ sourceRepoId: '', targetRepoId: '', twoWay: false, mappingNotesMd: '' });
  const create = trpc.repoLinks.create.useMutation({
    onSuccess: async () => {
      setForm({ sourceRepoId: '', targetRepoId: '', twoWay: false, mappingNotesMd: '' });
      toast.success('Repositories linked');
      await utils.repoLinks.list.invalidate();
    },
  });
  const list = repos.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Link two repositories</CardTitle>
        <CardDescription>You need access to both on GitHub.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(form);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="link-source">From</Label>
              <NativeSelect id="link-source" value={form.sourceRepoId} onChange={(e) => setForm({ ...form, sourceRepoId: e.target.value })} required>
                <option value="">Choose a repository</option>
                {list.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="link-target">To</Label>
              <NativeSelect id="link-target" value={form.targetRepoId} onChange={(e) => setForm({ ...form, targetRepoId: e.target.value })} required>
                <option value="">Choose a repository</option>
                {list
                  .filter((r) => r.id !== form.sourceRepoId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.fullName}
                    </option>
                  ))}
              </NativeSelect>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.twoWay} onChange={(e) => setForm({ ...form, twoWay: e.target.checked })} />
            Two-way: changes can go in both directions
          </label>
          <Notes id="link-notes" value={form.mappingNotesMd} onChange={(v) => setForm({ ...form, mappingNotesMd: v })} />
          {create.error && <Alert tone="destructive">{create.error.message}</Alert>}
          <div>
            <Button type="submit" disabled={create.isPending || !form.sourceRepoId || !form.targetRepoId}>
              Link repositories
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function LinkCard({ link: l, canEdit }: { link: Link; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const [notes, setNotes] = useState(l.mappingNotesMd);
  const refresh = () => utils.repoLinks.list.invalidate();
  const update = trpc.repoLinks.update.useMutation({ onSuccess: async () => (toast.success('Link saved'), refresh()) });
  const remove = trpc.repoLinks.delete.useMutation({ onSuccess: async () => (toast.success('Link removed'), refresh()) });
  const error = update.error ?? remove.error;
  return (
    <li>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base [overflow-wrap:anywhere]">
            <span>{l.source.fullName}</span>
            <span aria-label={l.twoWay ? 'both ways' : 'to'}>{l.twoWay ? '⇄' : '→'}</span>
            <span>{l.target.fullName}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {canEdit ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={l.twoWay} disabled={update.isPending} onChange={(e) => update.mutate({ id: l.id, twoWay: e.target.checked })} />
                Two-way
              </label>
              <Notes id={`notes-${l.id}`} value={notes} onChange={setNotes} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={update.isPending || notes === l.mappingNotesMd} onClick={() => update.mutate({ id: l.id, mappingNotesMd: notes })}>
                  Save notes
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => confirm(`Remove the link from ${l.source.fullName} to ${l.target.fullName}? Tasks already ported keep their links.`) && remove.mutate({ id: l.id })}
                >
                  Remove link
                </Button>
              </div>
            </>
          ) : l.mappingNotesMd ? (
            <div className="whitespace-pre-wrap break-words text-sm">{l.mappingNotesMd}</div>
          ) : (
            <p className="text-sm text-muted-foreground">No mapping notes.</p>
          )}
          {error && <Alert tone="destructive">{error.message}</Alert>}
        </CardContent>
      </Card>
    </li>
  );
}

function Notes({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>How the repositories map</Label>
      <textarea
        id={id}
        className={TEXTAREA}
        maxLength={MAX_NOTES}
        value={value}
        placeholder={'web/src/api/* ↔ mobile/lib/api/*\nComponents in web/src/ui are widgets in mobile/lib/widgets.'}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">Given to the agent with every ported change. Up to {MAX_NOTES.toLocaleString('en-US')} characters.</p>
    </div>
  );
}
