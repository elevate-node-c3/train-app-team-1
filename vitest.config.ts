import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Restate Vitest's defaults when overriding `exclude`; otherwise the
    // dependency tree and build output are scanned for specs.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    testTimeout: 30000,
  },
});
