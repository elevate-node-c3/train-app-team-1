import {
  cairoLocalTimeOf,
  type FilterOptions,
  type SearchFilters,
  type TrainTypeOption,
  type ValidationIssueRef,
} from '@app/contracts';

import { isUuid } from './trip-search-validation.js';

/**
 * Filter in memory over the shared cached day; filters never change cache keys
 * or add SQL queries. Compute facets from the unfiltered day first.
 */

const MINUTES_PER_DAY = 24 * 60;

export interface FilterableTrip {
  tripId: string;
  trainTypeId: string;
  trainTypeEn: string;
  trainTypeAr: string;
  originDepartureMillis: number;
  farePiastres: number | null;
}

/**
 * Validate filter shape only. A well-formed but unavailable train type matches
 * nothing rather than causing refusal, so stale clients can change their filters.
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

  // Refuse empty or overnight windows; one search covers one Cairo day.
  // Point at departBeforeMinutes so the traveller can fix the end bound.
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
 * Preserve incoming order. Use the existing batched sold-out set, without queries.
 * Require it when excludeSoldOut is requested so missing arguments cannot ignore the filter.
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

  // An empty type selection means any type, not no trips.
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

    // Unpriced trips cannot satisfy a price ceiling and are dropped as unsellable.
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
 * Filter by the passenger's Cairo departure clock, not UTC fields, so the window
 * matches the date and times shown to the traveller.
 */
function cairoDepartureMinute(originDepartureMillis: number): number {
  const { localTime } = cairoLocalTimeOf(new Date(originDepartureMillis));
  const [hour, minute] = localTime.split(':').map(Number);

  return hour * 60 + minute;
}

/**
 * Compute facets from the unfiltered day so all type and fare choices remain visible.
 * Deduplicate train types and sort by English name, then ID, for stable order.
 * Unpriced trips count toward types but do not affect the fare range.
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
    // Wire int32s cannot be absent; use a neutral zero range for empty or unpriced days.
    minFareMinor: minFareMinor === Number.POSITIVE_INFINITY ? 0 : minFareMinor,
    maxFareMinor: maxFareMinor === Number.NEGATIVE_INFINITY ? 0 : maxFareMinor,
  };
}
