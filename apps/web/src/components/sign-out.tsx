import { Button } from '@autodev/ui';
import { LogOut } from 'lucide-react';
import { signOut } from '@/auth';

/** Sign out. `menu` renders it as a row in the account menu. */
export function SignOutButton({ menu = false }: { menu?: boolean }) {
  return (
    <form
      action={async () => {
        'use server';
        await signOut({ redirectTo: '/login' });
      }}
    >
      {menu ? (
        <button type="submit" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary">
          <LogOut aria-hidden className="size-4 text-muted-foreground" />
          Sign out
        </button>
      ) : (
        <Button variant="ghost" size="sm" type="submit">
          Sign out
        </Button>
      )}
    </form>
  );
}
