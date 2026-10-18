import 'server-only';
import { authEnv, coreEnv, cryptoEnv, dbEnv, githubEnv, loadEnv } from '@autodev/config';
import { createKeyWrapper } from '@autodev/crypto';
import { createSystemDb } from '@autodev/db';
import { githubConfigFromEnv, TokenVault, type LoginDeps } from '@autodev/github';

const schema = coreEnv.merge(dbEnv).merge(cryptoEnv).merge(githubEnv).merge(authEnv);
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
    const cfg = githubConfigFromEnv(e);
    deps = { sys, cfg, vault: new TokenVault(sys, createKeyWrapper(e), cfg) };
  }
  return deps;
}
