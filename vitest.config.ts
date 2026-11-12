import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolve workspace path aliases.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Replacing exclude also replaces Vitest's defaults.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    testTimeout: 30000,
  },
});
