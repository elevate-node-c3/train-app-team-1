import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Restate Vitest's defaults when overriding `exclude`; otherwise the
    // dependency tree and build output are scanned for specs.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // These specs stop and start shared containers and wipe volumes. Running
    // files concurrently would tear down another file's stack mid-test.
    fileParallelism: false,
    // A stack build or a broker restart can take minutes; individual waits
    // still fail on their own shorter timeouts.
    testTimeout: 240_000,
    hookTimeout: 1_200_000,
  },
});
