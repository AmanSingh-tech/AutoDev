import { config } from 'dotenv';

config({ path: '../../.env' });
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url:
      process.env.DATABASE_URL_SYSTEM ??
      'postgres://autodev_system:autodev_system@localhost:5433/autodev',
  },
  strict: true,
});
