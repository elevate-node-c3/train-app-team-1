import { existsSync } from 'node:fs';

import { loadSync } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_PACKAGE_NAME,
  CATALOG_SERVICE_NAME,
  getCatalogProtoPath,
} from './catalog.grpc.js';
import type {
  FilterOptions,
  GetTripStopsRequest,
  ListRecentSearchesRequest,
  ListRecentSearchesResponse,
  RecentSearch,
  RecentSearchStation,
  SearchOneWayTripsRequest,
  SearchOneWayTripsResponse,
  SearchReturnTripsRequest,
  SearchReturnTripsResponse,
  TrainTypeOption,
  TripResult,
  TripStop,
  TripStopsResponse,
} from './catalog.dto.js';

/**
 * The descriptor shapes this spec reads.
 *
 * proto-loader types a loaded entry's `type` as a bare `object` — it is the
 * protobuf descriptor, whose fields it does not describe — so the parts
 * asserted on below have to be spelled out here.
 */
interface MessageDescriptor {
  field?: { name: string; type: string; number: number }[];
}

interface EnumDescriptor {
  value?: { name: string; number: number }[];
}

function descriptorOf(typeName: string): object {
  const definition = loadSync(getCatalogProtoPath());
  const entry = definition[`${CATALOG_PACKAGE_NAME}.${typeName}`];

  // A service definition is a map of methods and carries no `type`, so this
  // also rules out naming one by mistake.
  if (entry === undefined || !('type' in entry)) {
    throw new Error(`${typeName} is not a message or enum in the descriptor`);
  }

  return entry.type;
}

function messageDescriptor(messageName: string): MessageDescriptor {
  return descriptorOf(messageName) as MessageDescriptor;
}

function enumDescriptor(enumName: string): EnumDescriptor {
  return descriptorOf(enumName) as EnumDescriptor;
}

/**
 * Field names declared on a loaded message, in declaration order.
 *
 * Synthetic oneofs — the `_trainNumber` that proto3 `optional` generates —
 * live under `oneofDecl`, not `field`, so the list below is exactly the
 * author-declared fields.
 */
function fieldNamesOf(messageName: string): string[] {
  return (messageDescriptor(messageName).field ?? []).map(
    (field) => field.name,
  );
}

/**
 * The drift guard's other half. TypeScript interfaces vanish at runtime, so
 * each key map below is typed as `Record<keyof T, true>`: the compiler rejects
 * it if the interface gains a field the map omits, and the assertion rejects it
 * if the proto and the map disagree. Together they fail in both directions.
 */
const TRIP_RESULT_KEYS: Record<keyof TripResult, true> = {
  tripId: true,
  trainNumber: true,
  trainType: true,
  travelClass: true,
  departure: true,
  arrival: true,
  durationMinutes: true,
  intermediateStops: true,
  availableSeats: true,
  soldOut: true,
  fare: true,
};

const REQUEST_KEYS: Record<keyof SearchOneWayTripsRequest, true> = {
  originStationId: true,
  destinationStationId: true,
  departureDate: true,
  travelClassId: true,
  language: true,
  trainNumber: true,
  returnDate: true,
  sort: true,
  filters: true,
};

const RESPONSE_KEYS: Record<keyof SearchOneWayTripsResponse, true> = {
  dateStrip: true,
  trips: true,
  emptyResult: true,
  bookingWindow: true,
  evaluatedAt: true,
  filterOptions: true,
};

const FILTER_OPTIONS_KEYS: Record<keyof FilterOptions, true> = {
  trainTypes: true,
  minFareMinor: true,
  maxFareMinor: true,
};

const TRAIN_TYPE_OPTION_KEYS: Record<keyof TrainTypeOption, true> = {
  id: true,
  name: true,
  tripCount: true,
};

const RETURN_REQUEST_KEYS: Record<keyof SearchReturnTripsRequest, true> = {
  outboundTripId: true,
  outboundOriginStationId: true,
  outboundDestinationStationId: true,
  returnDate: true,
  travelClassId: true,
  language: true,
  sort: true,
  filters: true,
};

const RETURN_RESPONSE_KEYS: Record<keyof SearchReturnTripsResponse, true> = {
  trips: true,
  emptyResult: true,
  evaluatedAt: true,
  filterOptions: true,
};

const STOPS_REQUEST_KEYS: Record<keyof GetTripStopsRequest, true> = {
  tripId: true,
  originStationId: true,
  destinationStationId: true,
  language: true,
};

const TRIP_STOP_KEYS: Record<keyof TripStop, true> = {
  stationId: true,
  name: true,
  arrival: true,
  departure: true,
  boarding: true,
  alighting: true,
};

const STOPS_RESPONSE_KEYS: Record<keyof TripStopsResponse, true> = {
  stops: true,
};

const RECENT_SEARCH_REQUEST_KEYS: Record<
  keyof ListRecentSearchesRequest,
  true
> = {
  language: true,
};

const RECENT_SEARCH_STATION_KEYS: Record<
  keyof RecentSearchStation,
  true
> = {
  id: true,
  name: true,
};

const RECENT_SEARCH_KEYS: Record<keyof RecentSearch, true> = {
  origin: true,
  destination: true,
  travelClass: true,
  kind: true,
  trainNumber: true,
  departureDate: true,
  returnDate: true,
  searchedAt: true,
};

const RECENT_SEARCH_RESPONSE_KEYS: Record<
  keyof ListRecentSearchesResponse,
  true
> = {
  recentSearches: true,
};

describe('the catalog contract surface', () => {
  // Every spec in this folder imports its subject directly, so a module left
  // out of the barrel passes all of them and then fails at the first
  // cross-package import -- which is how apps actually consume this. Asserting
  // the barrel is what makes those specs representative.
  it('re-exports every catalog module from @app/contracts', async () => {
    const barrel = await import('../index.js');

    for (const name of [
      'CATALOG_PACKAGE_NAME',
      'CATALOG_SERVICE_NAME',
      'getCatalogProtoPath',
      'FARE_CURRENCY',
      'CAIRO_TIME_ZONE',
      'cairoCivilDateOf',
      'cairoLocalTimeOf',
      'cairoDayBounds',
      'cairoToday',
      'civilDateTimeOf',
      'durationMinutesBetween',
      'addCivilDays',
      'BOOKING_WINDOW_DAYS',
      'bookingWindowFor',
      'isWithinBookingWindow',
    ]) {
      expect(barrel, `${name} is missing from the barrel`).toHaveProperty(name);
    }
  });
});

describe('the catalog search gRPC contract', () => {
  it('resolves catalog.proto in this layout', () => {
    const path = getCatalogProtoPath();

    expect(path.endsWith('catalog.proto')).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('declares every catalog RPC on one service', () => {
    const definition = loadSync(getCatalogProtoPath());
    const service = definition[`${CATALOG_PACKAGE_NAME}.${CATALOG_SERVICE_NAME}`];

    expect(service).toBeDefined();
    expect(Object.keys(service!)).toEqual(
      expect.arrayContaining([
        'SearchOneWayTrips',
        'SearchReturnTrips',
        'GetTripStops',
        'ListRecentSearches',
      ]),
    );
  });

  it('keeps FilterOptions and its train-type facet in step', () => {
    expect(fieldNamesOf('FilterOptions').sort()).toEqual(
      Object.keys(FILTER_OPTIONS_KEYS).sort(),
    );
    expect(fieldNamesOf('TrainTypeOption').sort()).toEqual(
      Object.keys(TRAIN_TYPE_OPTION_KEYS).sort(),
    );
  });

  it('puts FilterOptions on the one-way response at field 6', () => {
    const field = (messageDescriptor('SearchOneWayTripsResponse').field ?? []).find(
      (candidate) => candidate.name === 'filterOptions',
    );

    // 6 was reserved before anything was serialized there, so taking it is
    // safe; 7 onwards stays reserved for a future page token.
    expect(field?.number).toBe(6);
  });

  it('keeps the return request and response in step', () => {
    expect(fieldNamesOf('SearchReturnTripsRequest').sort()).toEqual(
      Object.keys(RETURN_REQUEST_KEYS).sort(),
    );
    expect(fieldNamesOf('SearchReturnTripsResponse').sort()).toEqual(
      Object.keys(RETURN_RESPONSE_KEYS).sort(),
    );
  });

  // BR-20: the server reads the outbound arrival. A client-supplied arrival
  // would be a second authority and could widen the window.
  it('carries no outbound arrival and no train number on the return request', () => {
    const fields = fieldNamesOf('SearchReturnTripsRequest');

    expect(fields).not.toContain('outboundArrivalAt');
    expect(fields).not.toContain('arrivalAt');
    expect(fields).not.toContain('trainNumber');
  });

  it('keeps the stops messages in step', () => {
    expect(fieldNamesOf('GetTripStopsRequest').sort()).toEqual(
      Object.keys(STOPS_REQUEST_KEYS).sort(),
    );
    expect(fieldNamesOf('TripStop').sort()).toEqual(
      Object.keys(TRIP_STOP_KEYS).sort(),
    );
    expect(fieldNamesOf('TripStopsResponse').sort()).toEqual(
      Object.keys(STOPS_RESPONSE_KEYS).sort(),
    );
  });

  it('keeps the recent-search messages in step', () => {
    expect(fieldNamesOf('ListRecentSearchesRequest').sort()).toEqual(
      Object.keys(RECENT_SEARCH_REQUEST_KEYS).sort(),
    );
    expect(fieldNamesOf('RecentSearchStation').sort()).toEqual(
      Object.keys(RECENT_SEARCH_STATION_KEYS).sort(),
    );
    expect(fieldNamesOf('RecentSearch').sort()).toEqual(
      Object.keys(RECENT_SEARCH_KEYS).sort(),
    );
    expect(fieldNamesOf('ListRecentSearchesResponse').sort()).toEqual(
      Object.keys(RECENT_SEARCH_RESPONSE_KEYS).sort(),
    );
  });

  it('carries no traveller identity in the recent-search request', () => {
    // The traveller comes from caller metadata, never from a body a client
    // could forge.
    expect(fieldNamesOf('ListRecentSearchesRequest')).toEqual(['language']);
  });

  it('keeps TripResult in step with its TypeScript interface', () => {
    expect(fieldNamesOf('TripResult').sort()).toEqual(
      Object.keys(TRIP_RESULT_KEYS).sort(),
    );
  });

  it('keeps the request and response in step with their interfaces', () => {
    expect(fieldNamesOf('SearchOneWayTripsRequest').sort()).toEqual(
      Object.keys(REQUEST_KEYS).sort(),
    );
    expect(fieldNamesOf('SearchOneWayTripsResponse').sort()).toEqual(
      Object.keys(RESPONSE_KEYS).sort(),
    );
  });

  it('carries the fare as an integer that survives the JS boundary', () => {
    const field = (messageDescriptor('Money').field ?? []).find(
      (candidate) => candidate.name === 'amountMinor',
    );

    // Not int64: proto-loader maps 64-bit integers to JS strings by default,
    // which would silently turn a fare into a string at the gateway. int32
    // holds 21 million EGP in piastres — far beyond any single ticket.
    expect(field?.type).toBe('TYPE_INT32');
  });

  it('defaults the sort to departure-ascending, the mandated order', () => {
    // Proto3 enum 0 is the default an absent field decodes to, so TA-18 can
    // add sorts without changing what today's clients get.
    const zeroValue = (enumDescriptor('SearchSort').value ?? []).find(
      (value) => value.number === 0,
    );
    expect(zeroValue?.name).toBe('SEARCH_SORT_UNSPECIFIED');
  });

  it('keeps the appended search-empty reasons append-only', () => {
    // Existing numbers already travel; the two new reasons must extend the
    // enum rather than renumber it, or a client would read the wrong message.
    const byNumber = new Map(
      (enumDescriptor('SearchEmptyReason').value ?? []).map((value) => [
        value.number,
        value.name,
      ]),
    );

    expect(byNumber.get(1)).toBe('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED');
    expect(byNumber.get(2)).toBe('SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE');
    expect(byNumber.get(3)).toBe('SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE');
    expect(byNumber.get(4)).toBe(
      'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL',
    );
    expect(byNumber.get(5)).toBe('SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL');
  });
});
