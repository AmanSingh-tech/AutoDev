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

export const s3Env = z.object({
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('autodev'),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
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
