/**
 * The time-dependent half of BR-16.
 *
 * Everything here is a function of `now`, which is exactly why it is separated
 * from the query: the static facts about a trip can be cached, and these rules
 * are re-applied on every read. A list cached at 13:50 must not offer, at
 * 14:00, a trip whose sales closed at 13:55 -- and that is structurally
 * guaranteed only if the filter lives outside what gets stored.
 */

const MINUTE_MS = 60_000;

/** Sales stop this long before the train leaves the passenger's origin. */
export const SALES_CLOSE_LEAD_MINUTES = 15;

/**
 * The trip statuses that can be sold.
 *
 * `dated_trip.status` is draft | published | withdrawn, with no `cancelled`
 * value. Draft and withdrawn are both not-sellable, and withdrawn is what an
 * operator sets to pull a service, so it stands in for cancelled. Naming the
 * set here means the day a fourth status arrives, one line changes rather than
 * a predicate scattered through the SQL.
 */
export const SELLABLE_TRIP_STATUSES = ['published'] as const;

/**
 * How many days before the searched date a matching trip's `service_date` can
 * fall.
 *
 * A trip that leaves its first station at 23:00 on day D departs a mid-route
 * origin at 04:10 on D+1, so a search for D+1 has to consider trips dated D.
 * This bounds the SQL's pruning range. It is a named constant because
 * understating it loses overnight trips with no error -- the query simply
 * returns fewer rows.
 */
export const MAX_TRIP_DAY_SPAN_DAYS = 1;

/** The instant sales close for a departure. */
export function salesCloseAt(originDepartureMillis: number): number {
  return originDepartureMillis - SALES_CLOSE_LEAD_MINUTES * MINUTE_MS;
}

/**
 * Whether a trip can still be sold at `now`.
 *
 * Strictly `<`, so *exactly* 15 minutes before departure is CLOSED, as the
 * rule states. "Not departed" needs no separate check: it is strictly weaker
 * than this one.
 */
export function isSellableAt(
  originDepartureMillis: number,
  now: Date,
): boolean {
  return now.getTime() < salesCloseAt(originDepartureMillis);
}

/**
 * Drops the trips that are no longer on sale, preserving order.
 *
 * Generic over anything carrying the origin departure instant, so it applies
 * identically to rows straight from the database and to rows rehydrated from
 * the cache -- which is the point: one code path, so the cached case cannot
 * quietly skip the filter.
 */
export function applyDynamicEligibility<
  T extends { originDepartureMillis: number },
>(rows: readonly T[], now: Date): T[] {
  return rows.filter((row) => isSellableAt(row.originDepartureMillis, now));
}
