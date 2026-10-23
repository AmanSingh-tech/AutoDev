import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them. Third-party deps stay external.
  noExternal: [/^@autodev\//],
  // Packages the workspace pulls in transitively are bundled too, and some of them are CommonJS that
  // calls require(); give the ESM bundle a real require so they work.
  banner: { js: "import { createRequire as __autodevCreateRequire } from 'node:module'; const require = __autodevCreateRequire(import.meta.url);" },
});
