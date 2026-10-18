import { runMigrations } from '../src/migrate';
import { TEST_SYSTEM_URL } from './env';

export default async function setup() {
  await runMigrations(TEST_SYSTEM_URL);
}
