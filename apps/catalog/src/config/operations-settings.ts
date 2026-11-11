import type { LoggerService } from '@nestjs/common';

/**
 * Catalog's home for operations configuration (§6.5). A later task adds an
 * inventory-call timeout here too, so this stays standalone functions rather
 * than one frozen object.
 */

const STRIPE_MINIMUM_ENV_VAR = 'STRIPE_MINIMUM_CHARGE_PIASTRES';

// Stripe's actual EGP floor is not documented anywhere accessible to this
// repo. Refusing only non-positive fares until it is configured is still
// conservative -- it never admits a fare of zero or less.
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

/** Logs once, at warn, when the Stripe floor is unconfigured. Call from catalog's bootstrap. */
export function warnIfStripeFloorUnconfigured(logger: LoggerService): void {
  if (process.env[STRIPE_MINIMUM_ENV_VAR] !== undefined) return;
  if (warnedUnconfigured) return;

  warnedUnconfigured = true;
  logger.warn(
    `${STRIPE_MINIMUM_ENV_VAR} is unconfigured; fares below Stripe's minimum will be refused at checkout instead of at publish time.`,
  );
}
