'use client';

import { Button } from '@autodev/ui';
import { trpc } from '@/lib/trpc';

export function InstallAppButton({ label = 'Install on a GitHub org', variant = 'default' }: { label?: string; variant?: 'default' | 'outline' }) {
  const { data } = trpc.github.installUrl.useQuery();
  return (
    <Button asChild variant={variant} disabled={!data}>
      <a href={data?.url ?? '#'}>{label}</a>
    </Button>
  );
}
