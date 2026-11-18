import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

function dedicatedDatabase(variable: string, role: string): string {
  const value =
    process.env[variable] ??
    `postgres://${role}:${role}_mt02_test_only@127.0.0.1:25432/${role}`;
  const url = new URL(value);
  // MT-02 fixtures may truncate only this dedicated local test stack.
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '25432' ||
    url.pathname !== `/${role}`
  ) {
    throw new Error(
      `${variable} must target the dedicated MT-02 test database on 127.0.0.1:25432.`,
    );
  }
  return value;
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: [
      'test/integration/hold-*.int-spec.ts',
      'test/integration/mt02-*.int-spec.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.kilo/**'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      INVENTORY_TEST_DATABASE_URL: dedicatedDatabase(
        'MT02_INVENTORY_DATABASE_URL',
        'inventory',
      ),
      IDENTITY_TEST_DATABASE_URL: dedicatedDatabase(
        'MT02_IDENTITY_DATABASE_URL',
        'identity',
      ),
      BOOKING_TEST_DATABASE_URL: dedicatedDatabase(
        'MT02_BOOKING_DATABASE_URL',
        'booking',
      ),
      MT02_TEST_RABBITMQ_URL:
        'amqp://mt02:mt02_rabbit_test_only@127.0.0.1:35672',
    },
  },
});
