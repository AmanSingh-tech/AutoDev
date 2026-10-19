import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  // Bundled CommonJS dependencies (yaml, dockerode…) still call require().
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" },
  noExternal: [/^@autodev\//],
  define: { __AUTODEV_VERSION__: JSON.stringify(process.env.AUTODEV_VERSION ?? '0.1.0') },
});
