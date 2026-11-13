import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Replacing exclude also replaces Vitest's defaults.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // Shared containers and volumes need sequential test files.
    fileParallelism: false,
    // Stack builds and broker restarts can take minutes.
    testTimeout: 240_000,
    hookTimeout: 1_200_000,
  },
});
