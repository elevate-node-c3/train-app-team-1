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
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      // TA-70's holds tier owns these: they need their own database URLs and
      // truncate what they test. `npm run test:holds` runs them.
      'test/integration/hold-*.int-spec.ts',
      'test/integration/booking-hold.int-spec.ts',
      // TA-107's saga needs the holds tier's RabbitMQ and payment/inventory
      // database URLs; it has never run under this tier (see its own brief).
      'test/integration/booking-confirmation.int-spec.ts',
    ],
    // Shared database cleanup requires sequential test files.
    fileParallelism: false,
    // Allow time for first-run migrations.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
