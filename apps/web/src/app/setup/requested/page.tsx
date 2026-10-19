import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@autodev/ui';
import Link from 'next/link';

export default function SetupRequested() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Request sent</CardTitle>
          <CardDescription>
            GitHub sent your organization owners a request to install AutoDev. Once they approve it,
            sign in again to get started.
          </CardDescription>
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
