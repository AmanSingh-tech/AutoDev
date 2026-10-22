'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@autodev/ui';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';

type Visibility = 'all' | 'team_leads' | 'admins';

const VISIBILITY: { id: Visibility; label: string; hint: string }[] = [
  { id: 'admins', label: 'Admins only', hint: 'The default. Nobody else sees rankings.' },
  { id: 'team_leads', label: 'Team leads', hint: 'Admins, plus each team lead for the teams they lead.' },
  { id: 'all', label: 'Everyone in the organization', hint: 'Every member can see every board.' },
];

/** Who sees the leaderboard, whether cost is shown to non-admins, and badges. Admins only. */
export default function InsightsSettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.insights.settings.useQuery();
  const [form, setForm] = useState<{ leaderboardVisibility: Visibility; hideCostFromNonAdmins: boolean; badgesEnabled: boolean } | null>(null);
  useEffect(() => {
    if (settings.data && !form)
      setForm({ leaderboardVisibility: settings.data.leaderboardVisibility, hideCostFromNonAdmins: settings.data.hideCostFromNonAdmins, badgesEnabled: settings.data.badgesEnabled });
  }, [settings.data, form]);
  const save = trpc.insights.updateSettings.useMutation({
    onSuccess: () => {
      toast.success('Insights settings saved');
      void utils.insights.invalidate();
    },
  });

  if (!settings.data || !form) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const readOnly = !settings.data.isAdmin;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Insights</h1>
        <p className="text-sm text-muted-foreground">Insights are rebuilt nightly from usage, tasks, reviews and merged PRs. Admins always see everything.</p>
      </div>
      {readOnly && <Alert>Only admins can change these settings.</Alert>}
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>Who sees the leaderboard</CardTitle>
            <CardDescription>Leaderboards can be sensitive, so they start private. Team leads are set per team on the Members page.</CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset className="space-y-3" disabled={readOnly}>
              <legend className="sr-only">Leaderboard visibility</legend>
              {VISIBILITY.map((v) => (
                <label key={v.id} className="flex gap-3 text-sm">
                  <input type="radio" name="visibility" className="mt-1" checked={form.leaderboardVisibility === v.id} onChange={() => setForm({ ...form, leaderboardVisibility: v.id })} />
                  <span>
                    <span className="font-medium">{v.label}</span>
                    <span className="block text-muted-foreground">{v.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>What people see</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex gap-3 text-sm">
              <input type="checkbox" className="mt-1" disabled={readOnly} checked={form.hideCostFromNonAdmins} onChange={(e) => setForm({ ...form, hideCostFromNonAdmins: e.target.checked })} />
              <span>
                <span className="font-medium">Hide cost from non-admins</span>
                <span className="block text-muted-foreground">Cost and cost per PR are left out of the leaderboard and of team leads' insights.</span>
              </span>
            </label>
            <label className="flex gap-3 text-sm">
              <input type="checkbox" className="mt-1" disabled={readOnly} checked={form.badgesEnabled} onChange={(e) => setForm({ ...form, badgesEnabled: e.target.checked })} />
              <span>
                <span className="font-medium">Show badges</span>
                <span className="block text-muted-foreground">First merge, 10 merged PRs, Clean first pass (5 plans or designs in a row approved first time) and Efficient (lowest cost per PR, at least 3 PRs).</span>
              </span>
            </label>
          </CardContent>
        </Card>
        {save.error && <Alert tone="destructive">{save.error.message}</Alert>}
        {!readOnly && (
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
        )}
      </form>
    </div>
  );
}
