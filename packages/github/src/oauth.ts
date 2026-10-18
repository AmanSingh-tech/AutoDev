import type { GitHubConfig } from './config';
import { GitHubReauthRequired } from './errors';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

const inSeconds = (s: number | undefined, now: number) => (s ? new Date(now + s * 1000) : null);

export function tokenSetFromResponse(r: TokenResponse, now = Date.now()): TokenSet {
  if (!r.access_token) throw new Error(`GitHub token response missing access_token: ${r.error ?? ''}`);
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    accessExpiresAt: inSeconds(r.expires_in, now),
    refreshExpiresAt: inSeconds(r.refresh_token_expires_in, now),
  };
}

/**
 * Refreshes a GitHub App user-to-server token (access tokens last 8h, refresh tokens 6 months).
 * GitHub returns HTTP 200 with an `error` field on failure.
 */
export async function refreshUserToken(cfg: GitHubConfig, refreshToken: string): Promise<TokenSet> {
  const res = await fetch(`${cfg.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token refresh failed: HTTP ${res.status}`);
  const body = (await res.json()) as TokenResponse;
  if (body.error === 'bad_refresh_token') throw new GitHubReauthRequired(body.error_description);
  return tokenSetFromResponse(body);
}
