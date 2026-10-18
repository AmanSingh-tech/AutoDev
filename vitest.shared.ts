import { defineConfig } from 'vitest/config';

/** Every package has its own vitest.config.ts re-exporting this, so configs outside the repo are never picked up. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
});
