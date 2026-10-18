import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them. Third-party deps stay external.
  noExternal: [/^@autodev\//],
});
