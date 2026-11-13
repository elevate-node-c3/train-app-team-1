import { describe, expect, it } from 'vitest';

import { emptyReasonFor } from './trip-search-empty-reason.js';

/**
 * Empty reasons must identify the field to change, not collapse distinct problems
 * into one vague message.
 */
describe('choosing the empty-result reason', () => {
  it('blames the route when the pair is not served in this direction', () => {
    expect(
      emptyReasonFor({
        routeServed: false,
        trainNumberGiven: false,
        trainServesRoute: false,
        filtersExcludedAll: false,
      }),
    ).toBe('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED');
  });

  it('blames the route even when a train number was supplied', () => {
    // An unserved route outranks the train-number issue.
    expect(
      emptyReasonFor({
        routeServed: false,
        trainNumberGiven: true,
        trainServesRoute: false,
        filtersExcludedAll: false,
      }),
    ).toBe('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED');
  });

  it('blames the train when it does not serve a route that exists', () => {
    expect(
      emptyReasonFor({
        routeServed: true,
        trainNumberGiven: true,
        trainServesRoute: false,
        filtersExcludedAll: false,
      }),
    ).toBe('SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE');
  });

  it('blames the date when the train does serve the route', () => {
    expect(
      emptyReasonFor({
        routeServed: true,
        trainNumberGiven: true,
        trainServesRoute: true,
        filtersExcludedAll: false,
      }),
    ).toBe('SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE');
  });

  it('blames the date when no train number narrowed the search', () => {
    expect(
      emptyReasonFor({
        routeServed: true,
        trainNumberGiven: false,
        trainServesRoute: false,
        filtersExcludedAll: false,
      }),
    ).toBe('SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE');
  });

  it('blames the filters when the day had trips until they applied', () => {
    expect(
      emptyReasonFor({
        routeServed: true,
        trainNumberGiven: false,
        trainServesRoute: false,
        filtersExcludedAll: true,
      }),
    ).toBe('SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL');
  });

  it('still blames the route when filters also removed everything', () => {
    // Fix stations before filters when the route is not served.
    expect(
      emptyReasonFor({
        routeServed: false,
        trainNumberGiven: false,
        trainServesRoute: false,
        filtersExcludedAll: true,
      }),
    ).toBe('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED');
  });

  describe('the return leg', () => {
    it('blames the outbound arrival when nothing leaves after it', () => {
      expect(
        emptyReasonFor({
          routeServed: true,
          trainNumberGiven: false,
          trainServesRoute: false,
          filtersExcludedAll: false,
          nothingAfterOutboundArrival: true,
        }),
      ).toBe('SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL');
    });

    // Filters cannot restore returns that left before outbound arrival.
    it('outranks the filters', () => {
      expect(
        emptyReasonFor({
          routeServed: true,
          trainNumberGiven: false,
          trainServesRoute: false,
          filtersExcludedAll: true,
          nothingAfterOutboundArrival: true,
        }),
      ).toBe('SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL');
    });

    it('is outranked by an unserved reverse route', () => {
      expect(
        emptyReasonFor({
          routeServed: false,
          trainNumberGiven: false,
          trainServesRoute: false,
          filtersExcludedAll: false,
          nothingAfterOutboundArrival: true,
        }),
      ).toBe('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED');
    });

    // The one-way leg cannot be in this state, so it never passes the flag.
    it('is absent for the one-way leg', () => {
      expect(
        emptyReasonFor({
          routeServed: true,
          trainNumberGiven: false,
          trainServesRoute: false,
          filtersExcludedAll: false,
        }),
      ).toBe('SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE');
    });
  });

  it('never returns UNSPECIFIED, which would say nothing to the traveller', () => {
    for (const routeServed of [true, false]) {
      for (const trainNumberGiven of [true, false]) {
        for (const trainServesRoute of [true, false]) {
          for (const filtersExcludedAll of [true, false]) {
            for (const nothingAfterOutboundArrival of [
              true,
              false,
              undefined,
            ]) {
              expect(
                emptyReasonFor({
                  routeServed,
                  trainNumberGiven,
                  trainServesRoute,
                  filtersExcludedAll,
                  nothingAfterOutboundArrival,
                }),
              ).not.toBe('SEARCH_EMPTY_REASON_UNSPECIFIED');
            }
          }
        }
      }
    }
  });
});
