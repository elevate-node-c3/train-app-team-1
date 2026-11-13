import type { SearchEmptyReason } from '@app/contracts';

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
   * Return-only: all departures precede outbound arrival.
   * Optional because one-way searches cannot have this state.
   */
  nothingAfterOutboundArrival?: boolean;
}

/**
 * Name the field that can fix the result: route first, then train, arrival,
 * filters, and date. An unserved route outranks a supplied train number because
 * changing trains would not fix it.
 */
export function emptyReasonFor(facts: EmptyReasonFacts): SearchEmptyReason {
  if (!facts.routeServed) {
    return 'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED';
  }

  if (facts.trainNumberGiven && !facts.trainServesRoute) {
    return 'SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE';
  }

  // Arrival bounds outrank filters: no filter can restore an already-departed return.
  if (facts.nothingAfterOutboundArrival === true) {
    return 'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL';
  }

  // The day had trips before filtering, so name filters rather than the date.
  if (facts.filtersExcludedAll) {
    return 'SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL';
  }

  // The route exists and the train, if named, runs it: the date is the problem.
  return 'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE';
}
