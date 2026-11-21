/**
 * Every environment value the hold feature reads, resolved per call so a test
 * that stubs the environment is honoured and a restart is not required.
 *
 * inventory-env.schema.ts validates these at boot; the defaults here are the
 * same ones, so a value that passed validation reads back unchanged.
 */

/** The credential booking must present on the private hold transport. */
export function bookingInventoryServiceKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.BOOKING_INVENTORY_SERVICE_KEY;
}

/**
 * A rollback switch: it disables taking new ownership, never release, expiry
 * or durable publication, so holds already taken still end correctly.
 */
export function holdCreationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.HOLD_CREATION_ENABLED === 'true';
}

/** Off only when explicitly disabled; expiry must not stop by omission. */
export function holdExpiryWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.HOLD_EXPIRY_WORKER_ENABLED !== 'false';
}

export const DEFAULT_HOLD_EXPIRY_BATCH_SIZE = 500;
const MAX_HOLD_EXPIRY_BATCH_SIZE = 1000;

export function holdExpiryBatchSize(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.HOLD_EXPIRY_BATCH_SIZE);
  return Number.isInteger(raw) && raw > 0 && raw <= MAX_HOLD_EXPIRY_BATCH_SIZE
    ? raw
    : DEFAULT_HOLD_EXPIRY_BATCH_SIZE;
}

export const DEFAULT_HOLD_EXPIRY_POLL_INTERVAL_MS = 250;

export function holdExpiryPollIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.HOLD_EXPIRY_POLL_INTERVAL_MS);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : DEFAULT_HOLD_EXPIRY_POLL_INTERVAL_MS;
}
