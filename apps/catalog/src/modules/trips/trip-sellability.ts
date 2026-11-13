/**
 * Recheck sales rules after cache reads; cache only static trip data.
 * A cached list must stop offering trips as soon as sales close.
 */

const MINUTE_MS = 60_000;

/** Sales stop this long before the train leaves the passenger's origin. */
export const SALES_CLOSE_LEAD_MINUTES = 15;

/**
 * Only published trips are sellable. There is no cancelled status; withdrawn
 * represents a pulled service.
 */
export const SELLABLE_TRIP_STATUSES = ['published'] as const;

/**
 * Look back far enough in service_date pruning to include overnight trips.
 * A trip dated D can leave the passenger's origin on D+1; understating this
 * bound silently drops valid trips.
 */
export const MAX_TRIP_DAY_SPAN_DAYS = 1;

export function salesCloseAt(originDepartureMillis: number): number {
  return originDepartureMillis - SALES_CLOSE_LEAD_MINUTES * MINUTE_MS;
}

/**
 * Sales close exactly 15 minutes before origin departure; compare strictly <.
 * This also excludes departed trips, so no separate departure check is needed.
 */
export function isSellableAt(
  originDepartureMillis: number,
  now: Date,
): boolean {
  return now.getTime() < salesCloseAt(originDepartureMillis);
}

/**
 * Apply the same time filter to database and cached rows, preserving order.
 * Cache hits must not skip sellability checks.
 */
export function applyDynamicEligibility<
  T extends { originDepartureMillis: number },
>(rows: readonly T[], now: Date): T[] {
  return rows.filter((row) => isSellableAt(row.originDepartureMillis, now));
}
