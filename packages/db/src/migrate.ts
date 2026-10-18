import { config } from 'dotenv';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { createSystemDb } from './client';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createSystemDb(url, 1);
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  } finally {
    await close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL_SYSTEM;
  if (!url) throw new Error('DATABASE_URL_SYSTEM is required');
  await runMigrations(url);
  console.log('migrations applied');
}
