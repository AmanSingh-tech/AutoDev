import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AuthLayout } from '@/components/auth-layout';
import { StartDemo } from './start-demo';

/** "Try the demo": sign in with GitHub, then open (or create) your demo organization. */
export default async function DemoPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/demo');
  return (
    <AuthLayout>
      <StartDemo />
    </AuthLayout>
  );
}
