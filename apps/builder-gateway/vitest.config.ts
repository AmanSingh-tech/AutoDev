import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globalSetup: ['../../packages/db/test/global-setup.ts'],
      fileParallelism: false,
      // These tests wait on real sockets, Redis and the gateway's offline sweeper; leave headroom
      // for a loaded machine instead of the 5 s default.
      testTimeout: 20_000,
    },
  }),
);
