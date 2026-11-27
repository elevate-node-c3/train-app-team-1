import { generateKeyPairSync } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * TA-70's tier runs against the development stack from docker-compose.yml,
 * reached on the host ports the override publishes.
 *
 * These fixtures truncate the tables they test and the expiry-load spec stops
 * and starts the broker, so running this tier resets the local development
 * data for inventory, identity, booking and payment. The guard below keeps that
 * confined to the published local ports: it refuses any host or port that is
 * not this machine's compose stack, so no shared or remote database can ever
 * be the target.
 */
const HOST = '127.0.0.1';
const POSTGRES_PORT = process.env.POSTGRES_HOST_PORT?.trim() || '15432';
const AMQP_PORT = process.env.AMQP_HOST_PORT?.trim() || '15673';

/** Compose's own default, which .env overrides per machine. */
function password(variable: string, fallback: string): string {
  return process.env[variable]?.trim() || fallback;
}

function localDatabase(variable: string, role: string): string {
  const value =
    process.env[variable] ??
    `postgres://${role}:${password(
      `${role.toUpperCase()}_DB_PASSWORD`,
      `${role}_dev`,
    )}@${HOST}:${POSTGRES_PORT}/${role}`;
  const url = new URL(value);

  if (
    url.hostname !== HOST ||
    url.port !== POSTGRES_PORT ||
    url.pathname !== `/${role}`
  ) {
    throw new Error(
      `${variable} must target the local compose database ${role} on ${HOST}:${POSTGRES_PORT}; these fixtures truncate it.`,
    );
  }
  return value;
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // Local Compose tier: inventory holds, booking flow and payment schema.
    include: [
      'test/integration/hold-*.int-spec.ts',
      'test/integration/booking-hold.int-spec.ts',
      'test/integration/booking-confirmation.int-spec.ts',
      'test/integration/booking-confirmation-recovery.int-spec.ts',
      'test/integration/booking-confirmation-service.int-spec.ts',
      'test/integration/booking-flow-repository.int-spec.ts',
      'test/integration/booking-ticket-cancellation-migration.int-spec.ts',
      'test/integration/inventory-seat-occupation-released-state-migration.int-spec.ts',
      'test/integration/sold-seat-release.int-spec.ts',
      'test/integration/inventory-ticket-cancelled-consumer.int-spec.ts',
      'test/integration/payment-succeeded-consumer.int-spec.ts',
      'test/integration/ticket-cancelled-consumer.int-spec.ts',
      'test/integration/ticket-issuer.int-spec.ts',
      'test/integration/ticket-cancellation-service.int-spec.ts',
      'test/integration/ticket-cancellation-e2e.int-spec.ts',
      'test/integration/tickets.int-spec.ts',
      // These need payment's own database URL, which only this tier sets.
      'test/integration/payment-charge-refund-amount-migration.int-spec.ts',
      'test/integration/payment-processed-event-migration.int-spec.ts',
      'test/integration/payment-charge-webhook.int-spec.ts',
      'test/integration/payment-intent.service.int-spec.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.kilo/**'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      INVENTORY_TEST_DATABASE_URL: localDatabase(
        'HOLDS_INVENTORY_DATABASE_URL',
        'inventory',
      ),
      IDENTITY_TEST_DATABASE_URL: localDatabase(
        'HOLDS_IDENTITY_DATABASE_URL',
        'identity',
      ),
      BOOKING_TEST_DATABASE_URL: localDatabase(
        'HOLDS_BOOKING_DATABASE_URL',
        'booking',
      ),
      PAYMENT_TEST_DATABASE_URL: localDatabase(
        'HOLDS_PAYMENT_DATABASE_URL',
        'payment',
      ),
      HOLDS_TEST_RABBITMQ_URL: `amqp://${password(
        'RABBITMQ_USER',
        'train_app',
      )}:${password('RABBITMQ_PASSWORD', 'train_app')}@${HOST}:${AMQP_PORT}`,
      // The booking process these specs boot signs every ticket it issues
      // (TA-108); a fresh key per run, so no key file is ever committed.
      TICKET_SIGNING_PRIVATE_KEY: generateKeyPairSync('ed25519')
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    },
  },
});
