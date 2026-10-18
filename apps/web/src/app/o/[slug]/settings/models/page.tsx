'use client';

import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import { useEffect, useState } from 'react';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useOrg } from '../../org-shell';

type Price = RouterOutputs['models']['prices'][number];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PRICE_FIELDS = [
  ['inputPerMtok', 'Input'],
  ['outputPerMtok', 'Output'],
  ['cacheWrite5mPerMtok', 'Cache write 5m'],
  ['cacheWrite1hPerMtok', 'Cache write 1h'],
  ['cacheReadPerMtok', 'Cache read'],
] as const;

export default function ModelsPage() {
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const prices = trpc.models.prices.useQuery();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Models & prices</h1>
      <PolicyCard isAdmin={isAdmin} models={prices.data?.map((p) => p.model) ?? []} />
      <PricesCard isAdmin={isAdmin} prices={prices.data ?? []} />
    </div>
  );
}

function PolicyCard({ isAdmin, models }: { isAdmin: boolean; models: string[] }) {
  const utils = trpc.useUtils();
  const policies = trpc.models.policies.useQuery();
  const agent = policies.data?.find((p) => p.useCase === 'agent');
  const [form, setForm] = useState<{ model: string; maxTokensPerTask: number; maxOutputTokens: number; effort: string } | null>(null);
  const save = trpc.models.setPolicy.useMutation({ onSuccess: () => utils.models.policies.invalidate() });
  useEffect(() => {
    if (agent && !form) setForm({ model: agent.model, maxTokensPerTask: agent.maxTokensPerTask, maxOutputTokens: agent.maxOutputTokens, effort: agent.effort ?? '' });
  }, [agent, form]);
  if (!form || !agent) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Coding agent</CardTitle>
        <CardDescription>
          The model and limits every task uses. {agent.isDefault && <Badge variant="outline">Default</Badge>}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ useCase: 'agent', ...form, effort: (form.effort || null) as (typeof EFFORTS)[number] | null });
          }}
        >
          <fieldset disabled={!isAdmin || save.isPending} className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="model">Model</Label>
              <NativeSelect id="model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="effort">Effort</Label>
              <NativeSelect id="effort" value={form.effort} onChange={(e) => setForm({ ...form, effort: e.target.value })}>
                <option value="">Model default</option>
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cap">Max tokens per task</Label>
              <Input id="cap" type="number" min={10_000} step={10_000} value={form.maxTokensPerTask} onChange={(e) => setForm({ ...form, maxTokensPerTask: Number(e.target.value) })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="out">Max output tokens per call</Label>
              <Input id="out" type="number" min={1_000} max={128_000} value={form.maxOutputTokens} onChange={(e) => setForm({ ...form, maxOutputTokens: Number(e.target.value) })} />
            </div>
          </fieldset>
          {save.error && <Alert tone="destructive">{save.error.message}</Alert>}
          {save.isSuccess && <p className="text-sm text-muted-foreground">Saved.</p>}
          {isAdmin && (
            <div>
              <Button type="submit" disabled={save.isPending}>
                Save
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function PricesCard({ isAdmin, prices }: { isAdmin: boolean; prices: Price[] }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const invalidate = () => utils.models.prices.invalidate();
  const save = trpc.models.setPrice.useMutation({ onSuccess: () => (setEditing(null), invalidate()) });
  const reset = trpc.models.clearPriceOverride.useMutation({ onSuccess: invalidate });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Price table</CardTitle>
        <CardDescription>
          USD per million tokens, used to compute the cost of every call. Changes apply from now on; past usage keeps the price it was billed at.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <THead>
            <TR>
              <TH>Model</TH>
              {PRICE_FIELDS.map(([, l]) => (
                <TH key={l} className="text-right">
                  {l}
                </TH>
              ))}
              {isAdmin && <TH />}
            </TR>
          </THead>
          <TBody>
            {prices.map((p) => (
              <TR key={p.model}>
                <TD className="font-mono text-xs">
                  {p.model} {p.overridden && <Badge variant="outline">Custom</Badge>}
                </TD>
                {PRICE_FIELDS.map(([k]) => (
                  <TD key={k} className="text-right tabular-nums">
                    {editing === p.model ? (
                      <Input
                        aria-label={`${p.model} ${k}`}
                        className="ml-auto h-8 w-20 text-right"
                        value={draft[k] ?? ''}
                        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                      />
                    ) : (
                      `$${Number(p[k]).toString()}`
                    )}
                  </TD>
                ))}
                {isAdmin && (
                  <TD className="whitespace-nowrap text-right">
                    {editing === p.model ? (
                      <>
                        <Button size="sm" onClick={() => save.mutate({ model: p.model, ...(draft as Record<(typeof PRICE_FIELDS)[number][0], string>) })}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setDraft(Object.fromEntries(PRICE_FIELDS.map(([k]) => [k, String(Number(p[k]))])));
                            setEditing(p.model);
                          }}
                        >
                          Edit
                        </Button>
                        {p.overridden && (
                          <Button size="sm" variant="ghost" onClick={() => reset.mutate({ model: p.model })}>
                            Reset
                          </Button>
                        )}
                      </>
                    )}
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
        {save.error && <Alert tone="destructive" className="mt-3">{save.error.message}</Alert>}
      </CardContent>
    </Card>
  );
}
