import { Alert, Button } from '@autodev/ui';
import { Lock, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signIn } from '@/auth';
import { AuthLayout } from '@/components/auth-layout';

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
    <AuthLayout
      footer={
        <span>
          New to AutoDev?{' '}
          <Link href="/" className="font-medium text-foreground underline-offset-4 hover:underline">
            See what it does
          </Link>
        </span>
      }
    >
      <div className="rounded-xl border bg-card p-6 shadow-pop sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">Sign in to AutoDev</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Use your GitHub account. Your team’s repositories and permissions come with it.</p>
        <div className="mt-6 space-y-4">
          {params.reauth && <Alert>Your GitHub session expired. Sign in again to continue.</Alert>}
          {params.error && <Alert tone="destructive">Sign-in failed. Please try again.</Alert>}
          <form
            action={async () => {
              'use server';
              await signIn('github', { redirectTo: callbackUrl });
            }}
          >
            <Button type="submit" size="lg" className="w-full">
              <svg viewBox="0 0 16 16" aria-hidden className="size-4 fill-current">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Continue with GitHub
            </Button>
          </form>
          <ul className="space-y-2 border-t pt-4 text-xs text-muted-foreground">
            <li className="flex gap-2">
              <ShieldCheck aria-hidden className="size-4 shrink-0 text-success" />
              Commits and pull requests show you as the author, and AutoDev can only push where you can.
            </li>
            <li className="flex gap-2">
              <Lock aria-hidden className="size-4 shrink-0 text-success" />
              Your GitHub token is encrypted and never leaves the server.
            </li>
          </ul>
        </div>
      </div>
    </AuthLayout>
  );
}
