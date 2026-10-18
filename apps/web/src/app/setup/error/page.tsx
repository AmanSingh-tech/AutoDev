import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@autodev/ui';
import Link from 'next/link';

const MESSAGES: Record<string, string> = {
  not_github_admin:
    'Only a GitHub organization owner can finish connecting AutoDev to this organization. Ask an owner to sign in to AutoDev once, and then sign in again yourself.',
  installation_not_visible:
    'We couldn’t confirm that your GitHub account has access to this installation. Make sure you are signed in with the right GitHub account.',
  installation_owned_elsewhere: 'This installation is already connected to another AutoDev organization.',
  unsupported_account: 'AutoDev can only be installed on GitHub organizations or personal accounts.',
  bad_request: 'The setup link is incomplete. Try installing again from GitHub.',
};

export default async function SetupError({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Couldn’t finish setup</CardTitle>
          <CardDescription>{MESSAGES[reason ?? ''] ?? 'Something went wrong while connecting GitHub.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/orgs" className="text-sm underline">
            Back to AutoDev
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
