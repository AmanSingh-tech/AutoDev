'use client';

import { Button, Card, CardContent, Input } from '@autodev/ui';
import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';

/**
 * The task's Jira issue (B-7): link one, create one from the task, or unlink. Shown only when the
 * org has connected Jira. Status changes are posted to the issue by the worker every few minutes.
 */
export function JiraBox({ task, canEdit }: { task: { key: string; jiraIssueKey: string | null; jiraIssueStatus: string | null }; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const jira = trpc.jira.get.useQuery(undefined, { staleTime: 60_000 });
  const [issueKey, setIssueKey] = useState('');
  const done = (msg: string) => {
    toast.success(msg);
    setIssueKey('');
    void utils.tasks.get.invalidate({ key: task.key });
  };
  const link = trpc.jira.link.useMutation({ onSuccess: (i) => done(`Linked to ${i.key}`), onError: (e) => toast.error(e.message) });
  const unlink = trpc.jira.unlink.useMutation({ onSuccess: () => done('Unlinked from Jira'), onError: (e) => toast.error(e.message) });
  if (!jira.data) return null;
  const busy = link.isPending || unlink.isPending;

  return (
    <Card>
      <CardContent className="space-y-3 pt-6 text-sm">
        <div className="text-xs font-medium text-muted-foreground">Jira</div>
        {task.jiraIssueKey ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <a href={`${jira.data.siteUrl}/browse/${task.jiraIssueKey}`} target="_blank" rel="noreferrer" className="font-mono text-xs hover:underline">
                {task.jiraIssueKey}
              </a>
              {task.jiraIssueStatus && <span className="rounded-full border px-2 py-0.5 text-xs">{task.jiraIssueStatus}</span>}
            </div>
            {canEdit && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => unlink.mutate({ key: task.key })}>
                Unlink
              </Button>
            )}
          </>
        ) : canEdit ? (
          <>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (issueKey.trim()) link.mutate({ key: task.key, issueKey: issueKey.trim() });
              }}
            >
              <Input aria-label="Jira issue key" placeholder="WEB-123" value={issueKey} onChange={(e) => setIssueKey(e.target.value)} className="h-8" />
              <Button size="sm" type="submit" variant="outline" disabled={busy || !issueKey.trim()}>
                Link
              </Button>
            </form>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => link.mutate({ key: task.key, create: true })}>
              {link.isPending ? 'Working…' : `Create a Jira issue${jira.data.defaultProject ? ` in ${jira.data.defaultProject}` : ''}`}
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">Not linked.</p>
        )}
      </CardContent>
    </Card>
  );
}
