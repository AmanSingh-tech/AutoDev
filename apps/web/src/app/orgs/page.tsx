import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { SignOutButton } from '@/components/sign-out';
import { AuthLayout } from '@/components/auth-layout';
import { OrgPicker } from './org-picker';

export default async function OrgsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/orgs');
  return (
    <AuthLayout footer={<SignOutButton />}>
      <div className="rounded-xl border bg-card p-6 shadow-pop">
        <h1 className="text-lg font-semibold">Your organizations</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">Choose where to work.</p>
        <OrgPicker />
      </div>
    </AuthLayout>
  );
}
