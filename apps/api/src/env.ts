import { authEnv, coreEnv, cryptoEnv, dbEnv, githubEnv, llmEnv, loadEnv, redisEnv } from '@autodev/config';
import { z } from 'zod';

export const apiEnvSchema = coreEnv
  .merge(dbEnv)
  .merge(redisEnv)
  .merge(cryptoEnv)
  .merge(githubEnv)
  .merge(authEnv)
  .merge(llmEnv)
  .merge(
    z.object({
      PORT: z.coerce.number().int().default(4000),
      HOST: z.string().default('0.0.0.0'),
      /** Public WebSocket URL of the builder gateway, handed to the CLI at pairing. */
      BUILDER_GATEWAY_URL: z.string().url().default('ws://localhost:4100/builder'),
    }),
  );

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export const loadApiEnv = () => loadEnv(apiEnvSchema);
