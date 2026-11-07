import { describe, expect, it } from 'vitest';

import { emptyReasonFor } from './trip-search-empty-reason.js';

/**
 * Each reason tells the traveller a different thing to change -- the stations,
 * the date, the train number, or the filters (BR-57). Collapsing any two of
 * them into one message is the research finding this rule exists to prevent:
 * "I don't know what to change: station, date, or round-trip option".
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
    // The stations are the bigger problem; naming the train number would send
    // the traveller to fix the wrong field.
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
    // Fixing the filters would leave an unserved route, so the stations are
    // the field to change first.
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

    // Changing a filter cannot bring back a train that left before the
    // traveller landed, so the arrival is the thing to say.
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
