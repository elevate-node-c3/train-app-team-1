import type { LoggerService } from '@nestjs/common';

const STRIPE_MINIMUM_ENV_VAR = 'STRIPE_MINIMUM_CHARGE_PIASTRES';

// The default only rejects nonpositive fares; configure Stripe's actual EGP minimum.
const UNCONFIGURED_FLOOR_PIASTRES = 1;

let warnedUnconfigured = false;

/** Minimum chargeable fare in piastres. */
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

export function warnIfStripeFloorUnconfigured(logger: LoggerService): void {
  if (process.env[STRIPE_MINIMUM_ENV_VAR] !== undefined) return;
  if (warnedUnconfigured) return;

  warnedUnconfigured = true;
  logger.warn(
    `${STRIPE_MINIMUM_ENV_VAR} is unconfigured; fares below Stripe's minimum will be refused at checkout instead of at publish time.`,
  );
}

const INVENTORY_SEAT_USAGE_TIMEOUT_ENV_VAR = 'INVENTORY_SEAT_USAGE_TIMEOUT_MS';

// Bound publish latency when inventory is down.
const DEFAULT_INVENTORY_SEAT_USAGE_TIMEOUT_MS = 2000;

/** Refuse publication if inventory's seat-usage check exceeds this timeout. */
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

// Wait for recovery, not another request; keep this independent of the seat-usage timeout.
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
