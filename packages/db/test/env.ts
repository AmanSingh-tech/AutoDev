export const TEST_SYSTEM_URL =
  process.env.TEST_DATABASE_URL_SYSTEM ??
  'postgres://autodev_system:autodev_system@localhost:5433/autodev_test';
export const TEST_APP_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://autodev_app:autodev_app@localhost:5433/autodev_test';
