import { redirect } from 'next/navigation';

export default async function OrgIndex({ params }: { params: Promise<{ slug: string }> }) {
  redirect(`/o/${(await params).slug}/repos`);
}
