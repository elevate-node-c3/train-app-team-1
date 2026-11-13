import { existsSync } from 'node:fs';

import {
  loadSync,
  type Options,
  type ServiceDefinition,
} from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_PACKAGE_NAME,
  CATALOG_SERVICE_NAME,
  getCatalogProtoPath,
} from './catalog.grpc.js';
import type {
  CreateStationRequest,
  FilterOptions,
  GetTripStopsRequest,
  GovernorateGroup,
  ListRecentSearchesRequest,
  ListRecentSearchesResponse,
  ListStationsRequest,
  ListStationsResponse,
  RecentSearch,
  RecentSearchStation,
  SearchOneWayTripsRequest,
  SearchOneWayTripsResponse,
  SearchReturnTripsRequest,
  SearchReturnTripsResponse,
  StationAliases,
  StationDetails,
  StationIdRequest,
  StationItem,
  StationResponse,
  TrainTypeOption,
  TripResult,
  TripStop,
  TripStopsResponse,
  UpdateStationRequest,
} from './catalog.dto.js';

/**
 * The descriptor shapes this spec reads.
 *
 * proto-loader types a loaded entry's `type` as a bare `object` — it is the
 * protobuf descriptor, whose fields it does not describe — so the parts
 * asserted on below have to be spelled out here.
 */
interface MessageDescriptor {
  field?: {
    name: string;
    type: string;
    number: number;
    typeName?: string;
    oneofIndex?: number;
  }[];
  oneofDecl?: { name: string }[];
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

function serviceDefinition(options?: Options): ServiceDefinition {
  const definition = loadSync(getCatalogProtoPath(), options);
  return definition[
    `${CATALOG_PACKAGE_NAME}.${CATALOG_SERVICE_NAME}`
  ] as ServiceDefinition;
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

const RECENT_SEARCH_STATION_KEYS: Record<keyof RecentSearchStation, true> = {
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

const STATIONS_REQUEST_KEYS: Record<keyof ListStationsRequest, true> = {
  language: true,
  query: true,
};

const STATION_ITEM_KEYS: Record<keyof StationItem, true> = {
  id: true,
  name: true,
  cityName: true,
};

const GOVERNORATE_GROUP_KEYS: Record<keyof GovernorateGroup, true> = {
  id: true,
  name: true,
  stations: true,
};

const STATIONS_RESPONSE_KEYS: Record<keyof ListStationsResponse, true> = {
  governorates: true,
};

const STATION_DETAILS_KEYS: Record<keyof StationDetails, true> = {
  id: true,
  cityId: true,
  governorateId: true,
  name: true,
  cityName: true,
  governorateName: true,
  altSpellings: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

const STATION_RESPONSE_KEYS: Record<keyof StationResponse, true> = {
  station: true,
};

const STATION_ID_REQUEST_KEYS: Record<keyof StationIdRequest, true> = {
  stationId: true,
};

const CREATE_STATION_REQUEST_KEYS: Record<keyof CreateStationRequest, true> = {
  cityId: true,
  nameAr: true,
  nameEn: true,
  altSpellings: true,
  isActive: true,
};

const STATION_ALIASES_KEYS: Record<keyof StationAliases, true> = {
  values: true,
};

const UPDATE_STATION_REQUEST_KEYS: Record<keyof UpdateStationRequest, true> = {
  stationId: true,
  cityId: true,
  nameAr: true,
  nameEn: true,
  aliases: true,
  isActive: true,
};

const RPC_NAMES = [
  'ListStations',
  'SearchOneWayTrips',
  'SearchReturnTrips',
  'GetTripStops',
  'ListRecentSearches',
  'PublishTimetable',
  'ChangeFare',
  'ListAuditEntries',
  'GetStation',
  'CreateStation',
  'UpdateStation',
  'DeactivateStation',
] as const;

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
    const service = serviceDefinition();

    expect(service).toBeDefined();
    expect(Object.keys(service).sort()).toEqual([...RPC_NAMES].sort());
  });

  it.each(RPC_NAMES)(
    'keeps %s as a unary RPC on the catalog service',
    (name) => {
      const method = serviceDefinition()[name];

      expect(method.path).toBe(
        `/${CATALOG_PACKAGE_NAME}.${CATALOG_SERVICE_NAME}/${name}`,
      );
      expect(method.originalName).toBe(name[0].toLowerCase() + name.slice(1));
      expect(method.requestStream).toBe(false);
      expect(method.responseStream).toBe(false);
    },
  );

  it('keeps the station-picker messages in step with their interfaces', () => {
    expect(fieldNamesOf('ListStationsRequest').sort()).toEqual(
      Object.keys(STATIONS_REQUEST_KEYS).sort(),
    );
    expect(fieldNamesOf('StationItem').sort()).toEqual(
      Object.keys(STATION_ITEM_KEYS).sort(),
    );
    expect(fieldNamesOf('GovernorateGroup').sort()).toEqual(
      Object.keys(GOVERNORATE_GROUP_KEYS).sort(),
    );
    expect(fieldNamesOf('ListStationsResponse').sort()).toEqual(
      Object.keys(STATIONS_RESPONSE_KEYS).sort(),
    );
  });

  it.each([
    ['ListStationsRequest', { language: 1, query: 2 }],
    ['StationItem', { id: 1, name: 2, cityName: 3 }],
    ['GovernorateGroup', { id: 1, name: 2, stations: 3 }],
    ['ListStationsResponse', { governorates: 1 }],
  ] as const)(
    'preserves the station-picker field numbers on %s',
    (name, numbers) => {
      expect(
        Object.fromEntries(
          (messageDescriptor(name).field ?? []).map((field) => [
            field.name,
            field.number,
          ]),
        ),
      ).toEqual(numbers);
    },
  );

  it('keeps FilterOptions and its train-type facet in step', () => {
    expect(fieldNamesOf('FilterOptions').sort()).toEqual(
      Object.keys(FILTER_OPTIONS_KEYS).sort(),
    );
    expect(fieldNamesOf('TrainTypeOption').sort()).toEqual(
      Object.keys(TRAIN_TYPE_OPTION_KEYS).sort(),
    );
  });

  it('puts FilterOptions on the one-way response at field 6', () => {
    const field = (
      messageDescriptor('SearchOneWayTripsResponse').field ?? []
    ).find((candidate) => candidate.name === 'filterOptions');

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

describe('the station-picker gRPC payload', () => {
  it.each<ListStationsRequest>([
    { language: 'en', query: '  RaMsEs  ' },
    { language: 'ar', query: 'القاهرة' },
    { language: 'en' },
    { language: 'en', query: '' },
  ])('round-trips the language and raw optional query: %j', (request) => {
    const method = serviceDefinition().ListStations;

    expect(
      method.requestDeserialize(method.requestSerialize(request)),
    ).toStrictEqual(request);
  });

  it('round-trips flat governorates, station names and city names in order', () => {
    const response: ListStationsResponse = {
      governorates: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'القاهرة',
          stations: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              name: 'رمسيس',
              cityName: 'القاهرة',
            },
            {
              id: '33333333-3333-4333-8333-333333333333',
              name: 'Shubra',
              cityName: 'Cairo',
            },
          ],
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          name: 'Alexandria',
          stations: [
            {
              id: '55555555-5555-4555-8555-555555555555',
              name: 'Sidi Gaber',
              cityName: 'Alexandria',
            },
          ],
        },
      ],
    };
    const method = serviceDefinition().ListStations;

    expect(
      method.responseDeserialize(method.responseSerialize(response)),
    ).toStrictEqual(response);
  });

  // Default proto-loader decoding omits empty repeated fields; the gateway's
  // arrays option restores them. Both paths must retain the same wire shape.
  it.each([false, true])(
    'decodes empty governorates with arrays=%s',
    (arrays) => {
      const method = serviceDefinition({ enums: String, arrays }).ListStations;
      const response: ListStationsResponse = { governorates: [] };
      const encoded = method.responseSerialize(response);

      expect(encoded).toHaveLength(0);
      expect(method.responseDeserialize(encoded)).toStrictEqual(
        arrays ? response : {},
      );
    },
  );

  it.each([false, true])(
    'decodes nested empty stations with arrays=%s',
    (arrays) => {
      const response: ListStationsResponse = {
        governorates: [{ id: 'governorate-1', name: 'Cairo', stations: [] }],
      };
      const method = serviceDefinition({ enums: String, arrays }).ListStations;

      expect(
        method.responseDeserialize(method.responseSerialize(response)),
      ).toStrictEqual(
        arrays
          ? response
          : { governorates: [{ id: 'governorate-1', name: 'Cairo' }] },
      );
    },
  );
});

describe('the operator station gRPC contract', () => {
  const stationId = '11111111-1111-4111-8111-111111111111';
  const cityId = '22222222-2222-4222-8222-222222222222';
  const response: StationResponse = {
    station: {
      id: stationId,
      cityId,
      governorateId: '33333333-3333-4333-8333-333333333333',
      name: { en: 'Ramses', ar: 'رمسيس' },
      cityName: { en: 'Cairo', ar: 'القاهرة' },
      governorateName: { en: 'Cairo', ar: 'القاهرة' },
      altSpellings: [],
      isActive: false,
      createdAt: '2026-11-13T01:00:00.000Z',
      updatedAt: '2026-11-13T01:15:00.000Z',
    },
  };

  it.each([
    ['StationDetails', STATION_DETAILS_KEYS],
    ['StationResponse', STATION_RESPONSE_KEYS],
    ['StationIdRequest', STATION_ID_REQUEST_KEYS],
    ['CreateStationRequest', CREATE_STATION_REQUEST_KEYS],
    ['StationAliases', STATION_ALIASES_KEYS],
    ['UpdateStationRequest', UPDATE_STATION_REQUEST_KEYS],
  ] as const)('keeps %s in step with its shared DTO', (name, keys) => {
    expect(fieldNamesOf(name).sort()).toEqual(Object.keys(keys).sort());
  });

  it.each([
    [
      'StationDetails',
      {
        id: 1,
        cityId: 2,
        governorateId: 3,
        name: 4,
        cityName: 5,
        governorateName: 6,
        altSpellings: 7,
        isActive: 8,
        createdAt: 9,
        updatedAt: 10,
      },
    ],
    ['StationResponse', { station: 1 }],
    ['StationIdRequest', { stationId: 1 }],
    [
      'CreateStationRequest',
      { cityId: 1, nameAr: 2, nameEn: 3, altSpellings: 4, isActive: 5 },
    ],
    ['StationAliases', { values: 1 }],
    [
      'UpdateStationRequest',
      {
        stationId: 1,
        cityId: 2,
        nameAr: 3,
        nameEn: 4,
        aliases: 5,
        isActive: 6,
      },
    ],
  ] as const)('pins the new field numbers on %s', (name, numbers) => {
    expect(
      Object.fromEntries(
        (messageDescriptor(name).field ?? []).map((field) => [
          field.name,
          field.number,
        ]),
      ),
    ).toEqual(numbers);
  });

  it.each(['name', 'cityName', 'governorateName'])(
    'reuses LocalizedName for StationDetails.%s',
    (name) => {
      const field = (messageDescriptor('StationDetails').field ?? []).find(
        (candidate) => candidate.name === name,
      );
      expect(field?.type).toBe('TYPE_MESSAGE');
      expect(field?.typeName).toBe('LocalizedName');
    },
  );

  it.each(['StationDetails', 'CreateStationRequest', 'UpdateStationRequest'])(
    'uses explicit bool presence for %s.isActive',
    (name) => {
      const descriptor = messageDescriptor(name);
      const field = (descriptor.field ?? []).find(
        (candidate) => candidate.name === 'isActive',
      );
      expect(field?.type).toBe('TYPE_BOOL');
      // proto-loader represents explicit presence as a synthetic oneof.
      expect(field?.oneofIndex).toBeTypeOf('number');
      expect(descriptor.oneofDecl?.[field!.oneofIndex!]?.name).toBe(
        '_isActive',
      );
    },
  );

  it.each(['GetStation', 'DeactivateStation'])(
    '%s carries only the station ID',
    (name) => {
      const method = serviceDefinition()[name];
      const request: StationIdRequest = { stationId };
      expect(
        method.requestDeserialize(method.requestSerialize(request)),
      ).toStrictEqual(request);
      expect(fieldNamesOf('StationIdRequest')).toEqual(['stationId']);
    },
  );

  it.each([
    'GetStation',
    'CreateStation',
    'UpdateStation',
    'DeactivateStation',
  ])(
    '%s returns the full bilingual inactive snapshot with defaults disabled',
    (name) => {
      const method = serviceDefinition({
        enums: String,
        arrays: true,
        defaults: false,
      })[name];
      expect(
        method.responseDeserialize(method.responseSerialize(response)),
      ).toStrictEqual(response);
    },
  );

  it.each<CreateStationRequest>([
    { cityId, nameAr: 'رمسيس', nameEn: 'Ramses' },
    {
      cityId,
      nameAr: 'رمسيس',
      nameEn: 'Ramses',
      altSpellings: ['Ramsis', 'Cairo'],
      isActive: false,
    },
    { cityId, nameAr: 'رمسيس', nameEn: 'Ramses', isActive: true },
  ])(
    'round-trips a create without defaulting optional fields: %j',
    (request) => {
      const method = serviceDefinition({ defaults: false }).CreateStation;
      expect(
        method.requestDeserialize(method.requestSerialize(request)),
      ).toStrictEqual(request);
    },
  );

  it.each<UpdateStationRequest>([
    { stationId },
    { stationId, cityId },
    { stationId, nameAr: 'رمسيس' },
    { stationId, nameEn: 'Ramses' },
    { stationId, nameEn: '', isActive: false },
    { stationId, aliases: { values: ['Ramsis'] }, isActive: true },
  ])('round-trips a partial update without inventing fields: %j', (request) => {
    const method = serviceDefinition({ defaults: false }).UpdateStation;
    expect(
      method.requestDeserialize(method.requestSerialize(request)),
    ).toStrictEqual(request);
  });

  it.each([false, true])(
    'distinguishes omitted aliases from an explicit clear with arrays=%s',
    (arrays) => {
      const method = serviceDefinition({
        arrays,
        defaults: false,
      }).UpdateStation;
      const unchanged: UpdateStationRequest = { stationId };
      const clear: UpdateStationRequest = {
        stationId,
        aliases: { values: [] },
        isActive: false,
      };
      expect(
        method.requestDeserialize(method.requestSerialize(unchanged)),
      ).toStrictEqual(unchanged);
      expect(
        method.requestDeserialize(method.requestSerialize(clear)),
      ).toStrictEqual({
        stationId,
        aliases: arrays ? { values: [] } : {},
        isActive: false,
      });
    },
  );
});
