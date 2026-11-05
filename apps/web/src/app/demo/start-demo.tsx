'use client';

import { Alert, Button } from '@autodev/ui';
import { CircleCheck, Loader } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';

const STEPS = ['Creating Acme Cloud, a sample company', 'Adding repositories and teammates', 'Writing plans, code and test runs for sample tasks', 'Filling in a month of usage'];

/** Creates the demo org once, shows what's being set up, then opens it. */
export function StartDemo() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [shown, setShown] = useState(0);
  const started = useRef(false);
  const start = trpc.demo.start.useMutation({
    onSuccess: async (r) => {
      await utils.me.get.invalidate();
      router.replace(`/o/${r.slug}`);
    },
  });
  const mutate = useRef(start.mutate);
  useEffect(() => {
    // Once, even under React's development double-mount.
    if (!started.current) {
      started.current = true;
      mutate.current({});
    }
    const timer = setInterval(() => setShown((s) => Math.min(s + 1, STEPS.length)), 700);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="rounded-xl border bg-card p-6 shadow-pop sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight tracking-tight">Setting up your demo</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">A sample organization with a simulated agent. No GitHub repositories, AI key or builder needed, and nothing leaves AutoDev.</p>
      <ul className="mt-6 space-y-3 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className={i < shown ? 'flex items-center gap-2.5 text-foreground' : 'flex items-center gap-2.5 text-muted-foreground'}>
            {i < shown || start.isSuccess ? <CircleCheck aria-hidden className="size-4 text-success" /> : <Loader aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
            {s}
          </li>
        ))}
      </ul>
      {start.error && (
        <div className="mt-6 space-y-3">
          <Alert tone="destructive">{start.error.message}</Alert>
          <Button variant="outline" onClick={() => router.push('/orgs?pick=1')}>
            Your organizations
          </Button>
        </div>
      )}
    </div>
  );
}
