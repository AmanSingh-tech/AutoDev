'use client';

import type { OrgRole } from '@autodev/db/schema';
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  NativeSelect,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@autodev/ui';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useOrg } from '../org-shell';
import { toast } from 'sonner';

const ROLES: OrgRole[] = ['owner', 'admin', 'developer', 'viewer'];
const isAdmin = (r: OrgRole) => r === 'owner' || r === 'admin';

export default function MembersPage() {
  const org = useOrg();
  const canManage = isAdmin(org.role);
  const utils = trpc.useUtils();
  const members = trpc.members.list.useQuery();
  const [error, setError] = useState<string | null>(null);
  const onError = (e: { message: string }) => setError(e.message);
  const refreshAll = () => Promise.all([utils.members.list.invalidate(), utils.teams.list.invalidate()]);

  const setRole = trpc.members.setRole.useMutation({ onSuccess: refreshAll, onError });
  const setBilling = trpc.members.setBillingManager.useMutation({ onSuccess: refreshAll, onError });
  const setPrimary = trpc.members.setPrimaryTeam.useMutation({ onSuccess: refreshAll, onError });
  const teamsQ = trpc.teams.list.useQuery();
  const teamsOf = (userId: string) => (teamsQ.data ?? []).filter((t) => t.members.some((m) => m.userId === userId));
  const remove = trpc.members.remove.useMutation({
    onSuccess: () => {
      toast.success('Member removed');
      return refreshAll();
    },
    onError,
  });

  /** What this viewer may assign, mirroring the server rules (the server enforces them). */
  const assignable = (target: OrgRole) =>
    org.role === 'owner' ? ROLES : target === 'owner' || target === 'admin' ? [] : ROLES.filter((r) => r !== 'owner');

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Members</h1>
          <p className="text-sm text-muted-foreground">
            GitHub org members join automatically as{' '}
            <span className="font-medium">developer</span> (change the default in Settings) the
            first time they sign in.
          </p>
        </div>
        {error && <Alert tone="destructive">{error}</Alert>}
        <Table>
          <THead>
            <TR>
              <TH>Member</TH>
              <TH>Role</TH>
              <TH>Primary team</TH>
              {canManage && <TH className="text-right">Actions</TH>}
            </TR>
          </THead>
          <TBody>
            {members.data?.map((m) => {
              const options = assignable(m.role);
              return (
                <TR key={m.userId}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Avatar src={m.avatarUrl} alt={m.githubLogin} />
                      <span className="font-medium">{m.githubLogin}</span>
                      {m.name && <span className="text-muted-foreground">{m.name}</span>}
                    </div>
                  </TD>
                  <TD>
                    {canManage && options.length > 0 ? (
                      <NativeSelect
                        aria-label={`Role for ${m.githubLogin}`}
                        className="w-36"
                        value={m.role}
                        disabled={setRole.isPending}
                        onChange={(e) => {
                          setError(null);
                          setRole.mutate({ userId: m.userId, role: e.target.value as OrgRole });
                        }}
                      >
                        {options.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      m.role
                    )}
                    {canManage ? (
                      <label className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={m.billingManager}
                          disabled={setBilling.isPending}
                          onChange={(e) => setBilling.mutate({ userId: m.userId, billingManager: e.target.checked })}
                          aria-label={`${m.githubLogin} manages billing`}
                        />
                        Billing
                      </label>
                    ) : (
                      m.billingManager && <span className="ml-2 text-xs text-muted-foreground">billing</span>
                    )}
                  </TD>
                  <TD>
                    {canManage && teamsOf(m.userId).length > 1 ? (
                      <NativeSelect
                        aria-label={`Primary team for ${m.githubLogin}`}
                        className="w-40"
                        value={m.primaryTeamId ?? ''}
                        onChange={(e) => setPrimary.mutate({ userId: m.userId, teamId: e.target.value || null })}
                      >
                        <option value="">None (org key)</option>
                        {teamsOf(m.userId).map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <span className="text-muted-foreground">
                        {teamsOf(m.userId).find((t) => t.id === m.primaryTeamId)?.name ?? (teamsOf(m.userId).length === 1 ? teamsOf(m.userId)[0]!.name : '—')}
                      </span>
                    )}
                  </TD>
                  {canManage && (
                    <TD className="text-right">
                      {options.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (confirm(`Remove ${m.githubLogin} from ${org.name}?`)) {
                              setError(null);
                              remove.mutate({ userId: m.userId });
                            }
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </TD>
                  )}
                </TR>
              );
            })}
          </TBody>
        </Table>
      </section>
      <Teams canManage={canManage} members={members.data ?? []} onError={onError} />
    </div>
  );
}

function Teams({
  canManage,
  members,
  onError,
}: {
  canManage: boolean;
  members: { userId: string; githubLogin: string }[];
  onError: (e: { message: string }) => void;
}) {
  const utils = trpc.useUtils();
  const teams = trpc.teams.list.useQuery();
  const [name, setName] = useState('');
  const invalidate = () => utils.teams.list.invalidate();
  const create = trpc.teams.create.useMutation({ onSuccess: () => (setName(''), invalidate()), onError });
  const del = trpc.teams.delete.useMutation({ onSuccess: invalidate, onError });
  const add = trpc.teams.addMember.useMutation({ onSuccess: invalidate, onError });
  const removeMember = trpc.teams.removeMember.useMutation({ onSuccess: invalidate, onError });
  const setLead = trpc.teams.setLead.useMutation({ onSuccess: invalidate, onError });
  const me = trpc.me.get.useQuery().data?.user?.id;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Teams</h2>
        <p className="text-sm text-muted-foreground">
          A team can have its own AI key. For someone in several teams with keys, their primary team’s key is used. Team leads
          see Insights for their team and can add or remove its members.
        </p>
      </div>
      {canManage && (
        <form
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ name });
          }}
        >
          <Input placeholder="New team name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New team name" />
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </form>
      )}
      {teams.data?.length === 0 && <p className="text-sm text-muted-foreground">No teams yet.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {teams.data?.map((t) => {
          const inTeam = new Set(t.members.map((m) => m.userId));
          const candidates = members.filter((m) => !inTeam.has(m.userId));
          // Team leads change their own team's members (not its leads); admins change everything.
          const leads = t.members.some((m) => m.userId === me && m.isLead);
          const editMembers = canManage || leads;
          return (
            <Card key={t.id}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">{t.name}</CardTitle>
                {canManage && (
                  <Button variant="ghost" size="sm" onClick={() => confirm(`Delete team ${t.name}?`) && del.mutate({ teamId: t.id })}>
                    Delete
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1 text-sm">
                  {t.members.map((m) => (
                    <li key={m.userId} className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar src={m.avatarUrl} alt={m.githubLogin} className="h-5 w-5 shrink-0" />
                        <span className="truncate">{m.githubLogin}</span>
                        {m.isLead && !canManage && <span className="shrink-0 text-xs text-muted-foreground">lead</span>}
                      </span>
                      {!canManage && leads && (!m.isLead || m.userId === me) && (
                        <button className="shrink-0 text-xs text-muted-foreground hover:underline" onClick={() => removeMember.mutate({ teamId: t.id, userId: m.userId })}>
                          remove
                        </button>
                      )}
                      {canManage && (
                        <span className="flex shrink-0 items-center gap-3">
                          <label className="flex items-center gap-1 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={m.isLead}
                              disabled={setLead.isPending}
                              onChange={(e) => setLead.mutate({ teamId: t.id, userId: m.userId, isLead: e.target.checked })}
                              aria-label={`${m.githubLogin} leads ${t.name}`}
                            />
                            Lead
                          </label>
                          <button className="text-xs text-muted-foreground hover:underline" onClick={() => removeMember.mutate({ teamId: t.id, userId: m.userId })}>
                            remove
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                  {t.members.length === 0 && <li className="text-muted-foreground">No members</li>}
                </ul>
                {editMembers && candidates.length > 0 && (
                  <NativeSelect
                    aria-label={`Add member to ${t.name}`}
                    value=""
                    onChange={(e) => e.target.value && add.mutate({ teamId: t.id, userId: e.target.value })}
                  >
                    <option value="">Add member…</option>
                    {candidates.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.githubLogin}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
