import {
  cairoLocalTimeOf,
  type FilterOptions,
  type SearchFilters,
  type TrainTypeOption,
  type ValidationIssueRef,
} from '@app/contracts';

import { isUuid } from './trip-search-validation.js';

/**
 * Narrowing and sorting one day's trips (CAT-4).
 *
 * Everything here is in memory, over the list the query already produced. A
 * filter is not another cache key and not another statement: two travellers
 * asking for the same day with different filters share one cached day and
 * narrow it differently on the way out. That is also why the cache key will
 * never grow a filter segment.
 *
 * Pure throughout, so the rules are unit-testable without a database and the
 * service can compute the facets over the unfiltered day before applying the
 * request's own filters.
 */

const MINUTES_PER_DAY = 24 * 60;

/** The fields this module needs from a cacheable trip. */
export interface FilterableTrip {
  tripId: string;
  trainTypeId: string;
  trainTypeEn: string;
  trainTypeAr: string;
  originDepartureMillis: number;
  farePiastres: number | null;
}

/**
 * Refusals for a filter a traveller supplied.
 *
 * Shape only: whether the ids name real train types is not a refusal. A
 * well-formed id that is no longer offered simply matches nothing, and the
 * empty-result reason then names the filters -- the traveller can see and
 * change them (BR-57), whereas a hard refusal would make a stale client's
 * remembered choice unusable.
 */
export function validateFilters(
  filters: SearchFilters | undefined,
): ValidationIssueRef[] {
  if (filters === undefined) return [];

  const details: ValidationIssueRef[] = [];

  if (filters.trainTypeIds !== undefined) {
    for (const id of filters.trainTypeIds) {
      if (isUuid(id)) continue;

      details.push({
        field: 'trainTypeIds',
        rejectedValue: id,
        issueKey: 'ISSUE_TRAIN_TYPE_NOT_KNOWN',
        actionKey: 'ACTION_PICK_TRAIN_TYPE_FROM_LIST',
      });
    }
  }

  for (const field of ['departAfterMinutes', 'departBeforeMinutes'] as const) {
    const minutes = filters[field];
    if (minutes === undefined) continue;
    if (
      typeof minutes === 'number' &&
      Number.isInteger(minutes) &&
      minutes >= 0 &&
      minutes < MINUTES_PER_DAY
    ) {
      continue;
    }

    details.push({
      field,
      rejectedValue: minutes,
      issueKey: 'ISSUE_NOT_A_TIME_OF_DAY',
      actionKey: 'ACTION_PICK_TIME_IN_DAY',
    });
  }

  const after = filters.departAfterMinutes;
  const before = filters.departBeforeMinutes;
  const boundsAreValid =
    after !== undefined &&
    before !== undefined &&
    Number.isInteger(after) &&
    Number.isInteger(before) &&
    after >= 0 &&
    after < MINUTES_PER_DAY &&
    before >= 0 &&
    before < MINUTES_PER_DAY;

  // A window that runs past midnight would silently search two Cairo dates --
  // the date's own and the next one. BR-18 scopes the window to one civil day,
  // so it is refused rather than reinterpreted, and named against the bound
  // whose value has to move to make the window non-empty.
  if (boundsAreValid && after >= before) {
    details.push({
      field: 'departBeforeMinutes',
      rejectedValue: before,
      issueKey: 'ISSUE_WINDOW_ENDS_BEFORE_IT_STARTS',
      actionKey: 'ACTION_PICK_LATER_TIME_OR_CLEAR',
    });
  }

  if (filters.maxFareMinor !== undefined) {
    const maxFareMinor = filters.maxFareMinor;
    if (
      typeof maxFareMinor !== 'number' ||
      !Number.isInteger(maxFareMinor) ||
      maxFareMinor < 0
    ) {
      details.push({
        field: 'maxFareMinor',
        rejectedValue: maxFareMinor,
        issueKey: 'ISSUE_NOT_A_FARE_AMOUNT',
        actionKey: 'ACTION_FIX_OR_CLEAR_MAX_FARE',
      });
    }
  }

  if (
    filters.excludeSoldOut !== undefined &&
    typeof filters.excludeSoldOut !== 'boolean'
  ) {
    details.push({
      field: 'excludeSoldOut',
      rejectedValue: filters.excludeSoldOut,
      issueKey: 'ISSUE_MUST_BE_YES_OR_NO',
      actionKey: 'ACTION_CHOOSE_SOLD_OUT_PREFERENCE',
    });
  }

  return details;
}

/**
 * Applies the request's filters, preserving the incoming order.
 *
 * The sold-out set comes from the batched availability call the response
 * already needs; filtering by it here adds no query. It is required only when
 * the request asks for it, so a caller cannot quietly ignore the flag by
 * forgetting the argument.
 */
export function applyFilters<T extends FilterableTrip>(
  trips: readonly T[],
  filters: SearchFilters | undefined,
  soldOutTripIds?: ReadonlySet<string>,
): T[] {
  const active = filters ?? {};

  if (active.excludeSoldOut === true && soldOutTripIds === undefined) {
    throw new Error(
      'applyFilters needs the sold-out set when excludeSoldOut is requested',
    );
  }

  // An empty selection means "no type preference", not "no trips": that is
  // what an untouched filter form sends.
  const trainTypeIds =
    active.trainTypeIds === undefined || active.trainTypeIds.length === 0
      ? null
      : new Set(active.trainTypeIds);

  const after = active.departAfterMinutes;
  const before = active.departBeforeMinutes;
  const maxFareMinor = active.maxFareMinor;

  return trips.filter((trip) => {
    if (trainTypeIds !== null && !trainTypeIds.has(trip.trainTypeId)) {
      return false;
    }

    if (after !== undefined || before !== undefined) {
      const departureMinute = cairoDepartureMinute(trip.originDepartureMillis);

      if (after !== undefined && departureMinute < after) return false;
      if (before !== undefined && departureMinute > before) return false;
    }

    // An unpriced trip is dropped later as unsellable; it cannot satisfy a
    // price ceiling because there is no price to compare.
    if (
      maxFareMinor !== undefined &&
      (trip.farePiastres === null || trip.farePiastres > maxFareMinor)
    ) {
      return false;
    }

    if (active.excludeSoldOut === true && soldOutTripIds!.has(trip.tripId)) {
      return false;
    }

    return true;
  });
}

/**
 * The Cairo wall-clock minute this trip leaves the passenger's origin.
 *
 * BR-17 fixes the display zone, and BR-16 fixes which date the trip belongs
 * to, so the filter has to read the same wall clock the traveller sees rather
 * than the instant's UTC fields.
 */
function cairoDepartureMinute(originDepartureMillis: number): number {
  const { localTime } = cairoLocalTimeOf(new Date(originDepartureMillis));
  const [hour, minute] = localTime.split(':').map(Number);

  return hour * 60 + minute;
}

/**
 * The facets of a day, computed before the request's filters apply.
 *
 * Passing the unfiltered list is deliberate: a traveller who narrowed to one
 * train type must still see the other types, or the only way to undo the
 * filter would be to start over. The same holds for the fare range.
 *
 * Train types appear once each, ordered by English name with the id as a
 * tie-break, so two requests for the same day return the same facet order.
 * Unpriced trips still count towards a type -- the type does run that day --
 * but they cannot move the fare range, which is a range of actual prices.
 */
export function filterOptionsFor(
  trips: readonly FilterableTrip[],
): FilterOptions {
  const trainTypes = new Map<string, TrainTypeOption>();
  let minFareMinor = Number.POSITIVE_INFINITY;
  let maxFareMinor = Number.NEGATIVE_INFINITY;

  for (const trip of trips) {
    const existing = trainTypes.get(trip.trainTypeId);
    if (existing === undefined) {
      trainTypes.set(trip.trainTypeId, {
        id: trip.trainTypeId,
        name: { en: trip.trainTypeEn, ar: trip.trainTypeAr },
        tripCount: 1,
      });
    } else {
      existing.tripCount += 1;
    }

    if (trip.farePiastres !== null) {
      minFareMinor = Math.min(minFareMinor, trip.farePiastres);
      maxFareMinor = Math.max(maxFareMinor, trip.farePiastres);
    }
  }

  return {
    trainTypes: [...trainTypes.values()].sort(
      (left, right) =>
        left.name.en.localeCompare(right.name.en) ||
        left.id.localeCompare(right.id),
    ),
    // The wire carries int32s with no absence, so an unpriced or empty day
    // reports the neutral range rather than inventing a price.
    minFareMinor: minFareMinor === Number.POSITIVE_INFINITY ? 0 : minFareMinor,
    maxFareMinor: maxFareMinor === Number.NEGATIVE_INFINITY ? 0 : maxFareMinor,
  };
}
