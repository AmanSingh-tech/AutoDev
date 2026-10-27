import { authEnv, billingEnv, coreEnv, governanceEnv, ssoEnv, cryptoEnv, dbEnv, githubEnv, llmEnv, loadEnv, redisEnv, storageEnv } from '@autodev/config';
import { z } from 'zod';

export const apiEnvSchema = coreEnv
  .merge(dbEnv)
  .merge(redisEnv)
  .merge(cryptoEnv)
  .merge(githubEnv)
  .merge(authEnv)
  .merge(llmEnv)
  .merge(storageEnv)
  .merge(billingEnv)
  .merge(governanceEnv)
  .merge(ssoEnv)
  .merge(
    z.object({
      PORT: z.coerce.number().int().default(4000),
      HOST: z.string().default('0.0.0.0'),
      /** Public WebSocket URL of the builder gateway, handed to the CLI at pairing. */
      BUILDER_GATEWAY_URL: z.string().url().default('ws://localhost:4100/builder'),
      /** Both set: serve HTTPS with HTTP/2 (HTTP/1.1 still accepted). Browsers use HTTP/2 only over TLS. */
      TLS_CERT_FILE: z.string().optional(),
      TLS_KEY_FILE: z.string().optional(),
      /**
       * Which X-Forwarded-For hops to believe for the client's address (audit log, IP allowlists).
       * A number of proxies in front (e.g. 1 behind one load balancer), "true" for all (only when
       * nothing can reach the API directly), or a list of proxy addresses/CIDRs.
       */
      TRUST_PROXY: z
        .string()
        .default('true')
        .transform((v): boolean | number | string => (v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v)),
    }),
  );

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export const loadApiEnv = () => loadEnv(apiEnvSchema);
