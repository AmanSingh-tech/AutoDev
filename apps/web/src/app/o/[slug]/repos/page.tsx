'use client';

import { Alert, Badge, Button, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';

export default function ReposPage() {
  const welcome = useSearchParams().get('welcome');
  const { slug } = useParams<{ slug: string }>();
  const utils = trpc.useUtils();
  const repos = trpc.repos.list.useQuery();
  const refresh = trpc.repos.refresh.useMutation({
    onSuccess: (data) => {
      utils.repos.list.setData(undefined, data);
      toast.success(`Repositories refreshed: ${new Intl.PluralRules('en').select(data.length) === 'one' ? '1 repository' : `${data.length} repositories`} you can push to`);
    },
  });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Repositories</h1>
          <p className="text-sm text-muted-foreground">
            Repos where you can push on GitHub (push, maintain or admin). Checked again live before every push.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh from GitHub'}
        </Button>
      </div>

      {welcome && <Alert>AutoDev is installed. Repos can take a moment to show up after the first sync.</Alert>}
      {repos.error && <Alert tone="destructive">{repos.error.message}</Alert>}
      {repos.isLoading && <p className="text-sm text-muted-foreground">Loading repositories…</p>}

      {repos.data && repos.data.length === 0 && (
        <Alert>
          You don’t have write access to any repository in this installation. Ask a GitHub org
          admin to give you push access, or to add repos to the AutoDev installation.
        </Alert>
      )}

      {repos.data && repos.data.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH>Repository</TH>
              <TH>Default branch</TH>
              <TH>Your access</TH>
              <TH>Visibility</TH>
            </TR>
          </THead>
          <TBody>
            {repos.data.map((r) => (
              <TR key={r.id}>
                <TD className="font-medium">
                  <Link href={`/o/${slug}/repos/${r.name}`} className="hover:underline">
                    {r.fullName}
                  </Link>
                </TD>
                <TD className="font-mono text-xs">{r.defaultBranch}</TD>
                <TD>
                  <Badge variant="outline">{r.permission}</Badge>
                </TD>
                <TD className="text-muted-foreground">{r.private ? 'Private' : 'Public'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}
