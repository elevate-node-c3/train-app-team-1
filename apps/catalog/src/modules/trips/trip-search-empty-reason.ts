import type { SearchEmptyReason } from '@app/contracts';

/**
 * What the probes found out about a station pair when the search itself
 * returned nothing.
 */
export interface EmptyReasonFacts {
  /** Any published timetable stops at both stations, in travel order. */
  routeServed: boolean;
  /** The caller narrowed the search to a train number. */
  trainNumberGiven: boolean;
  /** That train's timetable stops at both stations, in travel order. */
  trainServesRoute: boolean;
  /** Trips existed, but the request's own filters removed every one. */
  filtersExcludedAll: boolean;
  /**
   * Return leg only: the day had trips, and every one of them departs before
   * the chosen outbound trip arrives.
   *
   * Optional because the one-way leg cannot be in this state at all, and a
   * flag a caller must remember to pass as `false` is a flag someone forgets.
   */
  nothingAfterOutboundArrival?: boolean;
}

/**
 * Picks the reason an empty result carries.
 *
 * Each reason points at a different field for the traveller to change
 * (BR-57): the stations, the date, or the train number. The ordering below is
 * deliberate -- an unserved route is reported as such even when a train number
 * was also supplied, because fixing the train number would not help and would
 * send the traveller to the wrong field.
 *
 * Pure by design: the two booleans come from `TripSearchRepository`'s probes,
 * so this decision is unit-testable with no database.
 */
export function emptyReasonFor(facts: EmptyReasonFacts): SearchEmptyReason {
  if (!facts.routeServed) {
    return 'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED';
  }

  if (facts.trainNumberGiven && !facts.trainServesRoute) {
    return 'SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE';
  }

  // Ranked above the filters on purpose. When the arrival bound emptied the
  // list, the filters never had anything to remove, and blaming them would
  // send the traveller to tweak a filter that was never the problem.
  if (facts.nothingAfterOutboundArrival === true) {
    return 'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL';
  }

  // The route and train are fine, and the day had trips until the filters were
  // applied: changing the date would not help, so name the filters instead.
  if (facts.filtersExcludedAll) {
    return 'SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL';
  }

  // The route exists and the train, if named, runs it: the date is the problem.
  return 'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE';
}
