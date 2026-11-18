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
    // DATABASE_URL is required, with no fallback in the code, so a test that
    // builds a service module needs it set just as the service does. Nothing
    // here connects; the integration tiers set their own real URL.
    env: {
      DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
    },
  },
});
