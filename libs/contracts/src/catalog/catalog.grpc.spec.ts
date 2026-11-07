import { existsSync } from 'node:fs';

import { loadSync } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_PACKAGE_NAME,
  CATALOG_SERVICE_NAME,
  getCatalogProtoPath,
} from './catalog.grpc.js';
import type {
  SearchOneWayTripsRequest,
  SearchOneWayTripsResponse,
  TripResult,
} from './catalog.dto.js';

/**
 * The descriptor shapes this spec reads.
 *
 * proto-loader types a loaded entry's `type` as a bare `object` — it is the
 * protobuf descriptor, whose fields it does not describe — so the parts
 * asserted on below have to be spelled out here.
 */
interface MessageDescriptor {
  field?: { name: string; type: string }[];
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
  sort: true,
  filters: true,
};

const RESPONSE_KEYS: Record<keyof SearchOneWayTripsResponse, true> = {
  dateStrip: true,
  trips: true,
  emptyResult: true,
  bookingWindow: true,
  evaluatedAt: true,
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

  it('declares SearchOneWayTrips on the catalog service', () => {
    const definition = loadSync(getCatalogProtoPath());
    const service = definition[`${CATALOG_PACKAGE_NAME}.${CATALOG_SERVICE_NAME}`];

    expect(service).toBeDefined();
    expect(Object.keys(service!)).toContain('SearchOneWayTrips');
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
});
