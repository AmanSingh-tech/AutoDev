'use client';

import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import { useState } from 'react';
import { relativeTime } from '@/lib/format';
import { PROVIDERS, providerLabel, type Provider } from '@/lib/providers';
import { trpc } from '@/lib/trpc';
import { useOrg } from '../../org-shell';
import { toast } from 'sonner';

type Scope = 'org' | 'team' | 'user';
const SCOPE_LABEL: Record<Scope, string> = { org: 'Organization', team: 'Team', user: 'Personal' };


export default function AiKeysPage() {
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const utils = trpc.useUtils();
  const keys = trpc.llmKeys.list.useQuery();
  const effective = trpc.llmKeys.effective.useQuery();
  const settings = trpc.orgs.current.useQuery();
  const teams = trpc.teams.list.useQuery(undefined, { enabled: isAdmin });
  const [replacing, setReplacing] = useState<{ scope: Scope; teamId?: string | null } | null>(null);
  const refresh = () => Promise.all([utils.llmKeys.list.invalidate(), utils.llmKeys.effective.invalidate()]);
  const revoke = trpc.llmKeys.revoke.useMutation({
    onSuccess: () => {
      toast.success('Key removed');
      return refresh();
    },
  });

  const scopes: Scope[] = [
    ...(isAdmin ? (['org', 'team'] as Scope[]) : []),
    ...(settings.data?.allowUserKeys && org.role !== 'viewer' ? (['user'] as Scope[]) : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">AI keys</h1>
        <p className="text-sm text-muted-foreground">
          Bring your own Anthropic key. The most specific key wins: personal, then team, then organization.
          Keys are encrypted, checked when saved and every day, and can never be viewed again.
        </p>
      </div>

      {effective.data ? (
        <Alert>
          Your tasks use the <span className="font-medium">{SCOPE_LABEL[effective.data.scope].toLowerCase()}</span> key ending in{' '}
          <span className="font-mono">…{effective.data.last4}</span>.
        </Alert>
      ) : effective.isSuccess ? (
        <Alert tone="destructive">No working key yet, so agent tasks can’t run. {isAdmin ? 'Add an organization key below.' : 'Ask an admin to add one.'}</Alert>
      ) : null}

      <Table>
        <THead>
          <TR>
            <TH>Key</TH>
            <TH>Applies to</TH>
            <TH>Status</TH>
            <TH>Last checked</TH>
            <TH className="text-right">Actions</TH>
          </TR>
        </THead>
        <TBody>
          {keys.data?.map((k) => (
            <TR key={k.id}>
              <TD>
                <div className="font-medium">{k.label}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {providerLabel(k.provider)}
                  {k.config.resource ? ` (${k.config.resource})` : k.config.region ? ` (${k.config.region})` : ''} · ••••{k.last4}
                </div>
              </TD>
              <TD>{k.scope === 'org' ? 'Organization' : k.scope === 'team' ? `Team ${k.teamName}` : `${k.userLogin} (personal)`}</TD>
              <TD>
                {k.status === 'active' ? (
                  <Badge variant="outline">✓ Active</Badge>
                ) : (
                  <span className="space-y-0.5">
                    <Badge variant="destructive">✕ Not working</Badge>
                    {k.lastError && <span className="block text-xs text-muted-foreground">{k.lastError}</span>}
                  </span>
                )}
              </TD>
              <TD className="text-muted-foreground">{relativeTime(k.lastValidatedAt)}</TD>
              <TD className="space-x-1 text-right">
                <Button variant="outline" size="sm" onClick={() => setReplacing({ scope: k.scope, teamId: k.teamId })}>
                  Replace
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => confirm(`Remove the key "${k.label}"? Tasks fall back to the next key.`) && revoke.mutate({ id: k.id })}
                >
                  Remove
                </Button>
              </TD>
            </TR>
          ))}
          {keys.data?.length === 0 && (
            <TR>
              <TD colSpan={5} className="py-6 text-center text-muted-foreground">
                No keys yet.
              </TD>
            </TR>
          )}
        </TBody>
      </Table>

      {scopes.length > 0 && (
        <AddKeyForm
          key={JSON.stringify(replacing)}
          scopes={scopes}
          teams={teams.data ?? []}
          preset={replacing}
          onDone={() => {
            setReplacing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function AddKeyForm({
  scopes,
  teams,
  preset,
  onDone,
}: {
  scopes: Scope[];
  teams: { id: string; name: string }[];
  preset: { scope: Scope; teamId?: string | null } | null;
  onDone: () => void;
}) {
  const [scope, setScope] = useState<Scope>(preset?.scope ?? scopes[0]!);
  const [teamId, setTeamId] = useState(preset?.teamId ?? '');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [config, setConfig] = useState({ resource: '', region: '' });
  const create = trpc.llmKeys.create.useMutation({
    onSuccess: () => {
      setApiKey('');
      setLabel('');
      toast.success('Key checked and saved');
      onDone();
    },
    // Clear the secret from the form even when the save fails.
    onSettled: () => setApiKey(''),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{preset ? 'Replace key' : 'Add a key'}</CardTitle>
        <CardDescription>
          {preset
            ? 'The new key is checked first. If it works it replaces the old one immediately, and tasks already running finish on the old key.'
            : 'We make a free test call to the provider before saving. Which provider each kind of work uses is set under Models.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-xl gap-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            const extra = provider === 'azure_openai' ? { resource: config.resource } : provider === 'bedrock' ? { region: config.region } : {};
            const base = { provider, label: label || `${PROVIDERS[provider].label} key`, apiKey, config: extra };
            if (scope === 'team') create.mutate({ ...base, scope, teamId });
            else create.mutate({ ...base, scope });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="scope">Applies to</Label>
              <NativeSelect id="scope" value={scope} disabled={!!preset} onChange={(e) => setScope(e.target.value as Scope)}>
                {scopes.map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_LABEL[s]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {scope === 'team' && (
              <div className="grid gap-1.5">
                <Label htmlFor="team">Team</Label>
                <NativeSelect id="team" value={teamId} disabled={!!preset} onChange={(e) => setTeamId(e.target.value)} required>
                  <option value="">Choose a team…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="provider">Provider</Label>
              <NativeSelect id="provider" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
                {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {provider === 'azure_openai' && (
              <div className="grid gap-1.5">
                <Label htmlFor="resource">Resource name</Label>
                <Input id="resource" placeholder="acme-ai (from acme-ai.openai.azure.com)" value={config.resource} onChange={(e) => setConfig({ ...config, resource: e.target.value.trim() })} required />
              </div>
            )}
            {provider === 'bedrock' && (
              <div className="grid gap-1.5">
                <Label htmlFor="region">AWS region</Label>
                <Input id="region" placeholder="us-east-1" value={config.region} onChange={(e) => setConfig({ ...config, region: e.target.value.trim() })} required />
              </div>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="label">Name</Label>
            <Input id="label" placeholder="e.g. Production key" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="apikey">{PROVIDERS[provider].keyLabel}</Label>
            <Input
              id="apikey"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={PROVIDERS[provider].placeholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
            />
          </div>
          {create.error && <Alert tone="destructive">{create.error.message}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" disabled={create.isPending || apiKey.length < 20}>
              {create.isPending ? 'Checking key…' : preset ? 'Check and replace' : 'Check and save'}
            </Button>
            {preset && (
              <Button type="button" variant="ghost" onClick={onDone}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
