import { z } from 'zod';

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

/** Turns literal "\n" sequences into newlines so PEM keys can live on one .env line. */
const pem = z.string().transform((v) => v.replace(/\\n/g, '\n'));

export const coreEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:4000'),
  /** This deployment's data region (B-7). Orgs are created in it and only served by a deployment of the same region. */
  DATA_REGION: z.string().regex(/^[a-z][a-z0-9-]{1,19}$/).default('us'),
});

export const dbEnv = z.object({
  /** Connects as the non-superuser app role, so row-level security applies. */
  DATABASE_URL: z.string().url(),
  /** BYPASSRLS role. Used only for migrations, webhook routing and cross-org cron jobs. */
  DATABASE_URL_SYSTEM: z.string().url(),
});

export const redisEnv = z.object({
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
});

/** Blob storage. Postgres is the default; S3 is any S3-compatible endpoint (MinIO in docker-compose). */
export const storageEnv = z.object({
  BLOB_DRIVER: z.enum(['postgres', 's3']).default('postgres'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().default('autodev'),
  S3_KEY: z.string().optional(),
  S3_SECRET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
});

/** The code index's local embedding model (worker only). */
export const codeIndexEnv = z.object({
  /** Where the model (about 160 MB) is downloaded on first use. Defaults to transformers.js' cache inside node_modules. */
  EMBEDDINGS_CACHE_DIR: z.string().optional(),
  /** `fake` (tests and e2e only): a bag-of-words stand-in, so no model is downloaded. */
  EMBEDDINGS_PROVIDER: z.enum(['local', 'fake']).default('local'),
});

/** Group Agent (B-5, worker only): where dependency scans look up advisories and latest versions. */
export const groupAgentEnv = z.object({
  OSV_API_URL: z.string().url().default('https://api.osv.dev'),
  NPM_REGISTRY_URL: z.string().url().default('https://registry.npmjs.org'),
  PYPI_URL: z.string().url().default('https://pypi.org'),
  GOPROXY_URL: z.string().url().default('https://proxy.golang.org'),
});

/**
 * Billing (B-6). Without STRIPE_SECRET_KEY, billing is off: no plans, no limits (self-hosting).
 * Prices are Stripe price IDs for a per-seat monthly price.
 */
export const billingEnv = z.object({
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_TEAM: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  STRIPE_API_URL: z.string().url().default('https://api.stripe.com'),
  TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(14),
});

export const ssoEnv = z.object({
  /** WorkOS (B-7): single sign-on and directory sync. Off without the API key and client id. */
  WORKOS_API_KEY: z.string().optional(),
  WORKOS_CLIENT_ID: z.string().optional(),
  WORKOS_WEBHOOK_SECRET: z.string().optional(),
  WORKOS_API_URL: z.string().url().default('https://api.workos.com'),
});

export const governanceEnv = z.object({
  /** Development only: let SIEM endpoints be http:// or private addresses (e.g. a local receiver). */
  OUTBOUND_ALLOW_PRIVATE: z.enum(['0', '1']).default('0'),
  /** Test/e2e only: where Jira is reached instead of <site>.atlassian.net. */
  JIRA_BASE_URL: z.string().url().optional(),
});

export const cryptoEnv = z.object({
  KMS_PROVIDER: z.enum(['local']).default('local'),
  /** Local KMS master key. Never used directly on data, only to wrap data keys. */
  MASTER_KEY: base64Key32,
  MASTER_KEY_ID: z.string().default('local-v1'),
});

export const githubEnv = z.object({
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_SLUG: z.string(),
  GITHUB_APP_CLIENT_ID: z.string(),
  GITHUB_APP_CLIENT_SECRET: z.string(),
  GITHUB_APP_PRIVATE_KEY: pem,
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  /** Overridable so tests can point at tools/mock-github. */
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_WEB_URL: z.string().url().default('https://github.com'),
});

export const llmEnv = z.object({
  /** Test/e2e override only. Admin-supplied provider config can never change where keys are sent. */
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  AZURE_OPENAI_BASE_URL: z.string().url().optional(),
  BEDROCK_BASE_URL: z.string().url().optional(),
});

export const authEnv = z.object({
  /** Shared by Auth.js (web) and the API, which decodes the same session JWT. */
  AUTH_SECRET: z.string().min(32),
});

export type CoreEnv = z.infer<typeof coreEnv>;

/** Validates process.env against a schema and fails fast with a readable error. */
export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data as z.infer<T>;
}
