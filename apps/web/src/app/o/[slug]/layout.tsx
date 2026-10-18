import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { auth } from '@/auth';
import { SignOutButton } from '@/components/sign-out';
import { OrgShell } from './org-shell';

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect(`/login?callbackUrl=/o/${slug}/repos`);
  return (
    <OrgShell slug={slug} signOut={<SignOutButton />}>
      {children}
    </OrgShell>
  );
}
