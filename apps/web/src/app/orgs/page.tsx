import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { SignOutButton } from '@/components/sign-out';
import { OrgPicker } from './org-picker';

export default async function OrgsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/orgs');
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your organizations</h1>
        <SignOutButton />
      </div>
      <OrgPicker />
    </main>
  );
}
