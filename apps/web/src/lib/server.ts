import 'server-only';
import { authEnv, coreEnv, cryptoEnv, dbEnv, githubEnv, loadEnv } from '@autodev/config';
import { createKeyWrapper } from '@autodev/crypto';
import { createSystemDb } from '@autodev/db';
import { githubConfigFromEnv, TokenVault, type LoginDeps } from '@autodev/github';

/**
 * Sign-in only uses the user's own token, so the web app (and its host, e.g. Vercel) never needs the
 * GitHub App private key or the webhook secret. Those stay with the API and the worker.
 */
const webGithubEnv = githubEnv.pick({
  GITHUB_APP_ID: true,
  GITHUB_APP_SLUG: true,
  GITHUB_APP_CLIENT_ID: true,
  GITHUB_APP_CLIENT_SECRET: true,
  GITHUB_API_URL: true,
  GITHUB_WEB_URL: true,
});
// Only sign-in touches the database (as the system role, to store the encrypted GitHub tokens).
const schema = coreEnv.merge(dbEnv.pick({ DATABASE_URL_SYSTEM: true })).merge(cryptoEnv).merge(webGithubEnv).merge(authEnv);
let env: ReturnType<typeof loadEnv<typeof schema>> | undefined;

/** Validated on first use rather than at import, so `next build` doesn't need runtime secrets. */
export function webEnv() {
  return (env ??= loadEnv(schema));
}

let deps: LoginDeps | undefined;

/** Server-only deps for completing a GitHub sign-in. The browser never receives tokens. */
export function loginDeps(): LoginDeps {
  if (!deps) {
    const e = webEnv();
    const sys = createSystemDb(e.DATABASE_URL_SYSTEM, 3).db;
    // No app credentials here: an app or installation client created from this config fails to authenticate.
    const cfg = githubConfigFromEnv({ ...e, GITHUB_APP_PRIVATE_KEY: '', GITHUB_WEBHOOK_SECRET: '' });
    deps = { sys, cfg, vault: new TokenVault(sys, createKeyWrapper(e), cfg) };
  }
  return deps;
}
