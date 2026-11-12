import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * The integration tier: specs that talk to a real Postgres or Redis from the
 * host, reached through the ports docker-compose.override.yml publishes.
 *
 * It sits between the two tiers that already existed. Unit specs (`*.spec.ts`)
 * need no infrastructure and must stay that way; e2e specs (`*.e2e-spec.ts`)
 * drive the gateway over HTTP and prove the whole path. Neither can check that
 * a SQL statement returns the right rows -- the first has no database and the
 * second cannot see past the response body.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    // Restate Vitest's defaults when overriding `exclude`; otherwise the
    // dependency tree and build output are scanned for specs.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // These specs share one database and truncate between cases. Running files
    // concurrently would let one file's cleanup delete another's fixtures.
    fileParallelism: false,
    // A first run may apply migrations against a cold container.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
