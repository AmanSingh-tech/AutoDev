import { redirect } from 'next/navigation';
import { missingConfig } from '@/lib/config-check';

export const dynamic = 'force-dynamic';

/** Shown instead of every page while required settings are missing. Names only, never values. */
export default function SetupConfigPage() {
  const missing = missingConfig();
  if (missing.length === 0) redirect('/');
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-4 py-12">
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">AutoDev</p>
        <h1 className="text-2xl font-semibold">Setup needed</h1>
        <p className="text-sm text-muted-foreground">
          This deployment is missing {missing.length === 1 ? 'a setting' : `${missing.length} settings`} it needs before anyone can sign in. Add{' '}
          {missing.length === 1 ? 'it' : 'them'} as environment variables (on Vercel: Project → Settings → Environment Variables), then redeploy.
        </p>
      </div>
      <ul className="divide-y rounded-lg border bg-card">
        {missing.map((m) => (
          <li key={m.name} className="space-y-1 px-4 py-3">
            <code className="text-sm font-medium">{m.name}</code>
            <p className="text-sm text-muted-foreground">{m.what}</p>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        The web app also needs the AutoDev API, worker and builder gateway running somewhere, with Postgres and Redis. The full list and the steps
        are in <code>docs/deploy-vercel.md</code> in the repository.
      </p>
    </main>
  );
}
