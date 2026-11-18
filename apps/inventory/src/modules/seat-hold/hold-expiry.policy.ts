/** A hold never lasts longer than this, even while ticket sales stay open. */
export const MAX_HOLD_DURATION_MS = 15 * 60 * 1000;

/** Ticket sales close this long before the train leaves the passenger's origin. */
export const SALES_CUTOFF_BEFORE_DEPARTURE_MS = 15 * 60 * 1000;

/** The single permitted extension, applied once while payment starts. */
export const EXTENSION_DURATION_MS = 5 * 60 * 1000;

export type HoldExpiryErrorCode =
  | 'INVALID_CURRENT_TIME'
  | 'INVALID_DEPARTURE_TIME'
  | 'INVALID_EXPIRY_TIME'
  | 'NO_ORIGIN_DEPARTURES'
  | 'SALES_CLOSED'
  | 'HOLD_EXPIRED';

/** Transport-neutral failure; adapters decide how to surface it. */
export class HoldExpiryError extends Error {
  constructor(
    readonly code: HoldExpiryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HoldExpiryError';
  }
}

export interface HoldExpiryInput {
  /** Inventory's current time, sampled from Postgres by the caller. */
  now: Date;
  /** Departure time from each passenger's boarding station, one per leg. */
  originDepartureTimes: readonly Date[];
}

export interface HoldExtensionInput {
  /** Inventory's current time, sampled from Postgres after any lock waits. */
  now: Date;
  /** The hold's current promised expiry. */
  expiresAt: Date;
  /** The current departure times for every leg still covered by the hold. */
  originDepartureTimes: readonly Date[];
}

/**
 * A hold expires at the earlier of now + 15 minutes and the earliest sales
 * cutoff across every leg. If that moment is not in the future, sales have
 * already closed for at least one leg.
 */
export function calculateHoldExpiry({
  now,
  originDepartureTimes,
}: HoldExpiryInput): Date {
  assertValidDate(
    now,
    'INVALID_CURRENT_TIME',
    'Current time must be a valid date.',
  );

  const salesCloseAt = earliestSalesClose(originDepartureTimes);

  const expiresAt = Math.min(
    now.getTime() + MAX_HOLD_DURATION_MS,
    salesCloseAt,
  );

  if (expiresAt <= now.getTime()) {
    throw new HoldExpiryError(
      'SALES_CLOSED',
      'Ticket sales for this trip are already closed.',
    );
  }

  return new Date(expiresAt);
}

/**
 * The one permitted extension is five minutes from the existing expiry, capped
 * at the current earliest sales cutoff. Returns null when the hold already
 * ends at or beyond that cutoff, so the caller does not consume its one use.
 */
export function calculateHoldExtension({
  now,
  expiresAt,
  originDepartureTimes,
}: HoldExtensionInput): Date | null {
  assertValidDate(
    now,
    'INVALID_CURRENT_TIME',
    'Current time must be a valid date.',
  );

  assertValidDate(
    expiresAt,
    'INVALID_EXPIRY_TIME',
    'Hold expiry must be a valid date.',
  );

  const salesCloseAt = earliestSalesClose(originDepartureTimes);

  if (expiresAt.getTime() <= now.getTime()) {
    throw new HoldExpiryError(
      'HOLD_EXPIRED',
      'The hold has already expired and cannot be extended.',
    );
  }

  const extended = Math.min(
    expiresAt.getTime() + EXTENSION_DURATION_MS,
    salesCloseAt,
  );

  return extended > expiresAt.getTime() ? new Date(extended) : null;
}

function earliestSalesClose(originDepartureTimes: readonly Date[]): number {
  if (originDepartureTimes.length === 0) {
    throw new HoldExpiryError(
      'NO_ORIGIN_DEPARTURES',
      'At least one passenger origin departure time is required.',
    );
  }

  let earliestDeparture = Number.POSITIVE_INFINITY;

  for (const departure of originDepartureTimes) {
    assertValidDate(
      departure,
      'INVALID_DEPARTURE_TIME',
      'Passenger origin departure time must be a valid date.',
    );
    earliestDeparture = Math.min(earliestDeparture, departure.getTime());
  }

  return earliestDeparture - SALES_CUTOFF_BEFORE_DEPARTURE_MS;
}

function assertValidDate(
  value: Date,
  code: HoldExpiryErrorCode,
  message: string,
): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new HoldExpiryError(code, message);
  }
}
