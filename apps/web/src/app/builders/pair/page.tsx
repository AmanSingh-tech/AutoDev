import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { PairBuilder } from './pair-builder';

export default async function PairPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const session = await auth();
  if (!session?.user?.id) redirect(`/login?callbackUrl=${encodeURIComponent(`/builders/pair${code ? `?code=${code}` : ''}`)}`);
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <PairBuilder initialCode={code ?? ''} />
    </main>
  );
}
