import type { LoggerService } from '@nestjs/common';

const STRIPE_MINIMUM_ENV_VAR = 'STRIPE_MINIMUM_CHARGE_PIASTRES';

// Stripe's EGP floor is not documented here; 1 piastre refuses zero or less
// until it is configured.
const UNCONFIGURED_FLOOR_PIASTRES = 1;

let warnedUnconfigured = false;

/** The smallest fare, in piastres, that Stripe will accept as a charge. */
export function stripeMinimumChargePiastres(): number {
  const raw = process.env[STRIPE_MINIMUM_ENV_VAR];
  if (raw === undefined) return UNCONFIGURED_FLOOR_PIASTRES;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${STRIPE_MINIMUM_ENV_VAR} must be a positive integer, got '${raw}'`,
    );
  }
  return parsed;
}

/** True when `amountPiastres` is a positive integer at or above the configured floor. */
export function isChargeableFare(amountPiastres: number): boolean {
  return (
    Number.isSafeInteger(amountPiastres) &&
    amountPiastres > 0 &&
    amountPiastres >= stripeMinimumChargePiastres()
  );
}

/** Warns once at bootstrap when the Stripe floor is unconfigured. */
export function warnIfStripeFloorUnconfigured(logger: LoggerService): void {
  if (process.env[STRIPE_MINIMUM_ENV_VAR] !== undefined) return;
  if (warnedUnconfigured) return;

  warnedUnconfigured = true;
  logger.warn(
    `${STRIPE_MINIMUM_ENV_VAR} is unconfigured; fares below Stripe's minimum will be refused at checkout instead of at publish time.`,
  );
}

const INVENTORY_SEAT_USAGE_TIMEOUT_ENV_VAR = 'INVENTORY_SEAT_USAGE_TIMEOUT_MS';

// Long enough for a publish click, short enough not to hang when inventory is down.
const DEFAULT_INVENTORY_SEAT_USAGE_TIMEOUT_MS = 2000;

/** How long catalog waits for inventory's seat-usage answer before refusing the publish. */
export function seatUsageTimeoutMs(): number {
  const raw = process.env[INVENTORY_SEAT_USAGE_TIMEOUT_ENV_VAR];
  if (raw === undefined) return DEFAULT_INVENTORY_SEAT_USAGE_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${INVENTORY_SEAT_USAGE_TIMEOUT_ENV_VAR} must be a positive integer, got '${raw}'`,
    );
  }
  return parsed;
}

// Longer than the seat-usage timeout on purpose: this waits for recovery,
// not for one more round trip. Do not derive one from the other.
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

/** Retry wait for `DEPENDENCY_UNAVAILABLE`, shared by the refusal text and the envelope. */
export function dependencyRetryAfterSeconds(): number {
  return DEPENDENCY_RETRY_AFTER_SECONDS;
}

const INVENTORY_GRPC_URL_ENV_VAR = 'INVENTORY_GRPC_URL';
const DEFAULT_INVENTORY_GRPC_URL = 'inventory:50051';

/** Inventory's gRPC URL; a blank value falls back to the default. */
export function inventoryGrpcUrl(): string {
  return nonEmpty(process.env[INVENTORY_GRPC_URL_ENV_VAR]) ?? DEFAULT_INVENTORY_GRPC_URL;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
