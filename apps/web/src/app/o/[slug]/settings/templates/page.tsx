'use client';

import { scorePrompt, TEMPLATE_KIND_LABEL, TEMPLATE_KINDS, type TemplateKind } from '@autodev/protocol/prompt-check';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect } from '@autodev/ui';
import { useState } from 'react';
import { PromptScoreBadge } from '@/components/prompt-guide';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useOrg } from '../../org-shell';

type Template = RouterOutputs['promptGuide']['templates']['list'][number];

const textarea =
  'flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export default function TemplatesPage() {
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const list = trpc.promptGuide.templates.list.useQuery();
  // `true` for a blank form, or a built-in template being copied.
  const [adding, setAdding] = useState<Template | boolean>(false);
  const builtIn = list.data?.filter((t) => t.builtIn) ?? [];
  const own = list.data?.filter((t) => !t.builtIn) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Task templates</h1>
        <p className="text-sm text-muted-foreground">
          Templates fill in a new task’s description and acceptance criteria. Write placeholders as [TODO: …]; the prompt
          score flags them until the author fills them in.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your organization</CardTitle>
          <CardDescription>{isAdmin ? 'Shown to everyone in the organization, after the built-in templates.' : 'Admins manage these.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {list.error && <Alert tone="destructive">{list.error.message}</Alert>}
          {own.map((t) => (
            <TemplateRow key={t.id} template={t} editable={isAdmin} />
          ))}
          {list.data && own.length === 0 && <p className="text-sm text-muted-foreground">No templates of your own yet.</p>}
          {isAdmin &&
            (adding ? (
              <TemplateForm
                key={typeof adding === 'object' ? adding.id : 'new'}
                initial={typeof adding === 'object' ? { ...adding, name: `${adding.name} (copy)` } : undefined}
                onDone={() => setAdding(false)}
              />
            ) : (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                Add template
              </Button>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Built-in</CardTitle>
          <CardDescription>Always available.{isAdmin && ' Copy one to start your own.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {builtIn.map((t) => (
            <TemplateRow key={t.id} template={t} editable={false} onCopy={isAdmin ? () => setAdding(t) : undefined} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function TemplateRow({ template: t, editable, onCopy }: { template: Template; editable: boolean; onCopy?: () => void }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const remove = trpc.promptGuide.templates.delete.useMutation({ onSuccess: () => utils.promptGuide.templates.list.invalidate() });
  if (editing) return <TemplateForm existing={t} initial={t} onDone={() => setEditing(false)} />;
  return (
    <details className="rounded-md border p-3">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{t.name}</span>
        {TEMPLATE_KIND_LABEL[t.kind] !== t.name && <span className="text-xs text-muted-foreground">{TEMPLATE_KIND_LABEL[t.kind]}</span>}
      </summary>
      <div className="mt-3 space-y-3">
        <pre className="whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">{t.descriptionMd || '(no description)'}</pre>
        <pre className="whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">{t.acceptanceCriteriaMd || '(no acceptance criteria)'}</pre>
        {onCopy && (
          <Button size="sm" variant="outline" onClick={onCopy}>
            Copy to your templates
          </Button>
        )}
        {editable && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => confirm(`Delete the “${t.name}” template?`) && remove.mutate({ id: t.id })}>
              Delete
            </Button>
          </div>
        )}
        {remove.error && <Alert tone="destructive">{remove.error.message}</Alert>}
      </div>
    </details>
  );
}

function TemplateForm({ existing, initial, onDone }: { existing?: Template; initial?: Pick<Template, 'name' | 'kind' | 'descriptionMd' | 'acceptanceCriteriaMd'>; onDone: () => void }) {
  const utils = trpc.useUtils();
  const done = () => {
    void utils.promptGuide.templates.list.invalidate();
    onDone();
  };
  const create = trpc.promptGuide.templates.create.useMutation({ onSuccess: done });
  const update = trpc.promptGuide.templates.update.useMutation({ onSuccess: done });
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<TemplateKind>(initial?.kind ?? 'feature');
  const [desc, setDesc] = useState(initial?.descriptionMd ?? '');
  const [ac, setAc] = useState(initial?.acceptanceCriteriaMd ?? '');
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  // How a task built from this template scores once its placeholders are filled in.
  const filled = (s: string) => s.replace(/\[TODO:[^\]]*\]/g, 'details in `src/example.ts`');
  const preview = scorePrompt({ title: name || 'A specific task title', descriptionMd: filled(desc), acceptanceCriteriaMd: filled(ac) });

  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fields = { name, kind, descriptionMd: desc, acceptanceCriteriaMd: ac };
        if (existing) update.mutate({ id: existing.id, ...fields });
        else create.mutate(fields);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="tpl-name">Name</Label>
          <Input id="tpl-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="tpl-kind">Kind</Label>
          <NativeSelect id="tpl-kind" value={kind} onChange={(e) => setKind(e.target.value as TemplateKind)}>
            {TEMPLATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {TEMPLATE_KIND_LABEL[k]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tpl-desc">Description</Label>
        <textarea id="tpl-desc" className={textarea} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tpl-ac">Acceptance criteria</Label>
        <textarea id="tpl-ac" className={textarea} value={ac} onChange={(e) => setAc(e.target.value)} />
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        Score once the placeholders are filled in: <PromptScoreBadge score={preview.score} />
      </p>
      {error && <Alert tone="destructive">{error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {existing ? 'Save' : 'Add template'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
