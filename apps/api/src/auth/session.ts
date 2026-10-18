import './webcrypto-polyfill';
import { decode } from '@auth/core/jwt';

/** Auth.js (next-auth v5) cookie names. The __Secure- prefix is used over HTTPS. */
export const SESSION_COOKIES = ['__Secure-authjs.session-token', 'authjs.session-token'] as const;

export interface Session {
  userId: string;
}

/**
 * Decodes the Auth.js session JWT the web app set. Both sides share AUTH_SECRET, and the
 * cookie name is the key-derivation salt. Returns null for a missing, invalid or expired token.
 */
export async function readSession(
  cookies: Record<string, string | undefined>,
  secret: string,
): Promise<Session | null> {
  for (const name of SESSION_COOKIES) {
    const token = cookies[name];
    if (!token) continue;
    try {
      const payload = await decode({ token, secret, salt: name });
      if (payload && typeof payload.uid === 'string') return { userId: payload.uid };
    } catch {
      return null;
    }
  }
  return null;
}
