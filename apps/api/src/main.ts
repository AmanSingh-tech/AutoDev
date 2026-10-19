import { readFileSync } from 'node:fs';
import { createDeps } from './deps';
import { loadApiEnv } from './env';
import { buildServer } from './server';

const env = loadApiEnv();
const deps = createDeps(env);
const tls =
  env.TLS_CERT_FILE && env.TLS_KEY_FILE
    ? { cert: readFileSync(env.TLS_CERT_FILE), key: readFileSync(env.TLS_KEY_FILE), allowHTTP1: true }
    : null;
// HTTP/2 lets one tab keep its event stream open without using up the browser's 6-connection limit.
const app = await buildServer(deps, tls ? ({ http2: true, https: tls } as never) : {});
await deps.bridge.start();

const shutdown = async () => {
  await app.close();
  await deps.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
