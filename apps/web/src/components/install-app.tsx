'use client';

import { Button } from '@autodev/ui';
import { trpc } from '@/lib/trpc';

export function InstallAppButton({ label = 'Install on a GitHub org' }: { label?: string }) {
  const { data } = trpc.github.installUrl.useQuery();
  return (
    <Button asChild disabled={!data}>
      <a href={data?.url ?? '#'}>{label}</a>
    </Button>
  );
}
