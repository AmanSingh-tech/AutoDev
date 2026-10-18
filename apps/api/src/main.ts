import { createDeps } from './deps';
import { loadApiEnv } from './env';
import { buildServer } from './server';

const env = loadApiEnv();
const deps = createDeps(env);
const app = await buildServer(deps);

const shutdown = async () => {
  await app.close();
  await deps.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
