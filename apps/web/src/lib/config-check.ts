/**
 * Which settings the web app can't run without, checked by name only (never values), so a fresh
 * deployment shows a "Setup needed" page instead of crashing. Edge-safe: no imports. The full
 * validation (formats, lengths) still happens in lib/server.ts when the settings are used.
 */
export const REQUIRED_CONFIG: { name: string; what: string }[] = [
  { name: 'AUTH_SECRET', what: 'Signs sessions. At least 32 characters, the same value as the API’s.' },
  { name: 'DATABASE_URL_SYSTEM', what: 'Postgres (system role), used at sign-in to store encrypted GitHub tokens. Use a pooled URL.' },
  { name: 'MASTER_KEY', what: 'Encrypts tokens and keys. The same value as the API’s.' },
  { name: 'GITHUB_APP_ID', what: 'Your GitHub App’s ID.' },
  { name: 'GITHUB_APP_SLUG', what: 'Your GitHub App’s URL name.' },
  { name: 'GITHUB_APP_CLIENT_ID', what: 'Your GitHub App’s OAuth client ID.' },
  { name: 'GITHUB_APP_CLIENT_SECRET', what: 'Your GitHub App’s OAuth client secret.' },
];

/** In production these must point somewhere real, not at the localhost defaults. */
const PUBLIC_URLS: { name: string; what: string }[] = [
  { name: 'WEB_URL', what: 'This site’s own address, e.g. https://autodev.example.com.' },
  { name: 'API_URL', what: 'The hosted API’s address. Changing it needs a redeploy (it’s used at build time).' },
];

export function missingConfig(env: Record<string, string | undefined> = process.env): { name: string; what: string }[] {
  const missing = REQUIRED_CONFIG.filter((c) => !env[c.name]?.trim());
  if (env.NODE_ENV === 'production') {
    for (const u of PUBLIC_URLS) if (!env[u.name]?.trim() || /localhost|127\.0\.0\.1/.test(env[u.name]!)) missing.push(u);
  }
  return missing;
}
