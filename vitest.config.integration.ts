import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/** Integration tests use real Postgres/Redis through local Compose ports. */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    // Replacing exclude also replaces Vitest's defaults.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // Shared database cleanup requires sequential test files.
    fileParallelism: false,
    // Allow time for first-run migrations.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
