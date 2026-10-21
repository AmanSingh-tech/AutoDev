'use client';

import { Button } from '@autodev/ui';
import { toast } from 'sonner';
import { int, relativeTime } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import { useEvents } from '@/lib/use-events';

/** One line under the chat heading: how search finds code in this repo, and whether the index is current. */
export function CodeIndexStatus({ orgId, repoId }: { orgId: string; repoId: string }) {
  const utils = trpc.useUtils();
  const status = trpc.codeIndex.status.useQuery({ repoId });
  useEvents(orgId, [`repo:${repoId}`], (events) => {
    if (events.some((e) => e.type === 'code_index.status')) void utils.codeIndex.status.invalidate({ repoId });
  });
  const reindex = trpc.codeIndex.reindex.useMutation({
    onSuccess: () => toast.success('Rebuild queued'),
    onError: (e) => toast.error(e.message),
  });
  if (!status.data) return null;
  const { enabled, canReindex, state } = status.data;

  let text: string;
  if (!enabled) text = 'Search uses GitHub code search. An admin can turn on the code index in Settings for search by meaning.';
  else if (!state || (!state.commitSha && state.status !== 'failed')) text = 'Building the code index… Search uses GitHub code search until it’s ready.';
  else if (state.status === 'failed')
    text = `The last code index run failed${state.error ? `: ${state.error}` : ''}.${state.commitSha ? ` Search uses the index at ${state.commitSha.slice(0, 7)}.` : ''}`;
  else if (state.status === 'indexing' || state.status === 'pending') text = `Updating the code index… Search uses the index at ${state.commitSha!.slice(0, 7)} meanwhile.`;
  else
    text = `Code index: ${int(state.files)} files at ${state.commitSha!.slice(0, 7)}, updated ${relativeTime(state.finishedAt)}.${
      state.skippedFiles ? ` ${int(state.skippedFiles)} files left out (over the per-repo limit).` : ''
    }${state.error ? ` ${state.error}` : ''}`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Code index">
      <span className="[overflow-wrap:anywhere]">{text}</span>
      {enabled && canReindex && state?.status !== 'indexing' && (
        <Button variant="ghost" size="sm" className="h-auto px-1 py-0 text-xs" disabled={reindex.isPending} onClick={() => reindex.mutate({ repoId })}>
          Rebuild
        </Button>
      )}
    </div>
  );
}
