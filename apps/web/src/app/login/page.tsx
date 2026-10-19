import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@autodev/ui';
import { redirect } from 'next/navigation';
import { auth, signIn } from '@/auth';

/** Only same-site relative paths, so callbackUrl can't be used as an open redirect. */
function safeCallback(url: string | undefined) {
  if (!url) return '/orgs';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    const web = new URL(process.env.WEB_URL ?? 'http://localhost:3000');
    return parsed.origin === web.origin ? parsed.pathname + parsed.search : '/orgs';
  } catch {
    return '/orgs';
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; reauth?: string; error?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallback(params.callbackUrl);
  const session = await auth();
  if (session?.user?.id && !params.reauth) redirect(callbackUrl);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to AutoDev</CardTitle>
          <CardDescription>
            AutoDev acts on GitHub as you. Commits and PRs show you as the author, and it can only
            push where you can.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {params.reauth && <Alert>Your GitHub session expired. Sign in again to continue.</Alert>}
          {params.error && <Alert tone="destructive">Sign-in failed. Please try again.</Alert>}
          <form
            action={async () => {
              'use server';
              await signIn('github', { redirectTo: callbackUrl });
            }}
          >
            <Button type="submit" className="w-full">
              Continue with GitHub
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
