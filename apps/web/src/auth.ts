import { completeLogin, type GitHubProfile } from '@autodev/github';
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { headers } from 'next/headers';
import { loginDeps, webEnv } from './lib/server';

const SESSION_MAX_AGE = 7 * 24 * 3600;

/**
 * Sign-in goes through the GitHub App's OAuth client, so the tokens we get are user-to-server
 * tokens, and pushes and PRs later show the user as author. The tokens are encrypted into
 * github_tokens on sign-in and never go into the session JWT.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = webEnv();
  return {
    secret: env.AUTH_SECRET,
    trustHost: true,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE },
    pages: { signIn: '/login', error: '/login' },
    providers: [
      GitHub({
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        // Explicit endpoints, so tests can point at tools/mock-github. GitHub Apps ignore scopes.
        authorization: {
          url: `${env.GITHUB_WEB_URL}/login/oauth/authorize`,
          params: { scope: '' },
        },
        token: `${env.GITHUB_WEB_URL}/login/oauth/access_token`,
        userinfo: {
          url: `${env.GITHUB_API_URL}/user`,
          async request({ tokens }: { tokens: { access_token?: string } }) {
            const res = await fetch(`${env.GITHUB_API_URL}/user`, {
              headers: { authorization: `Bearer ${tokens.access_token}`, 'user-agent': 'autodev' },
            });
            if (!res.ok) throw new Error(`GitHub /user failed: ${res.status}`);
            return res.json();
          },
        },
      }),
    ],
    callbacks: {
      async jwt({ token, account, profile }) {
        if (account && profile) {
          const h = await headers().catch(() => null);
          const now = Date.now();
          const refreshIn = Number(
            (account as Record<string, unknown>).refresh_token_expires_in ?? 0,
          );
          const { userId } = await completeLogin(loginDeps(), {
            profile: profile as unknown as GitHubProfile,
            tokens: {
              accessToken: account.access_token!,
              refreshToken: account.refresh_token ?? null,
              accessExpiresAt: account.expires_at ? new Date(account.expires_at * 1000) : null,
              refreshExpiresAt: refreshIn ? new Date(now + refreshIn * 1000) : null,
            },
            ip: h?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
            userAgent: h?.get('user-agent') ?? null,
          });
          // Only our user id goes in the session JWT, no GitHub tokens.
          return { uid: userId, name: token.name, picture: token.picture };
        }
        return token;
      },
      session({ session, token }) {
        if (typeof token.uid === 'string') session.user.id = token.uid;
        return session;
      },
    },
  };
});
