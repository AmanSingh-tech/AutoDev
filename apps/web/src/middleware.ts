import { NextResponse, type NextRequest } from 'next/server';
import { missingConfig } from './lib/config-check';

/**
 * Until the deployment has its settings, every page shows /setup/config instead of a server error.
 * API routes are left alone (they fail with their own errors), and so are static files.
 */
export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/setup/config') return NextResponse.next();
  if (missingConfig().length === 0) return NextResponse.next();
  return NextResponse.rewrite(new URL('/setup/config', req.url));
}

export const config = {
  matcher: ['/((?!api/|_next/|monaco/|favicon.ico|.*\\.[a-z0-9]+$).*)'],
};
