import {
  CALLER_ACCOUNT_ID_HEADER,
  CALLER_ACCOUNT_ID_KEY,
  CALLER_BOOKABLE_HEADER,
  CALLER_BOOKABLE_KEY,
  CALLER_JTI_HEADER,
  CALLER_JTI_KEY,
  CALLER_ROLES_HEADER,
  CALLER_ROLES_KEY,
  CALLER_SESSION_ID_HEADER,
  CALLER_SESSION_ID_KEY,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
} from '@app/common';
import { ErrorCode } from '@app/contracts';
import type {
  CreateStationRequest,
  ListStationsRequest,
  ListStationsResponse,
  SearchOneWayTripsResponse,
  StationResponse,
  UpdateStationRequest,
  ValidationIssueRef,
} from '@app/contracts';
import { Metadata, type CallOptions } from '@grpc/grpc-js';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import {
  CATALOG_SEARCH_TIMEOUT_MS,
  CatalogGrpcClientService,
} from './catalog.grpc.client.js';
import type { CatalogGrpcClient } from './catalog.types.js';

const request = {
  originStationId: '11111111-1111-4111-8111-111111111111',
  destinationStationId: '22222222-2222-4222-8222-222222222222',
  departureDate: '2026-06-20',
  travelClassId: '33333333-3333-4333-8333-333333333333',
};

const STATIONS_REQUEST: ListStationsRequest = {
  language: 'en',
  query: '  RaMsEs  ',
};

const STATIONS_RESPONSE: ListStationsResponse = {
  governorates: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Cairo',
      stations: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Ramses',
          cityName: 'Cairo',
        },
      ],
    },
  ],
};

const STATION_ID = request.originStationId;
const IDEMPOTENCY_KEY = 'station-change-1';
const CREATE_STATION_REQUEST: CreateStationRequest = {
  cityId: request.destinationStationId,
  nameAr: '\u0631\u0645\u0633\u064a\u0633',
  nameEn: 'Ramses',
  altSpellings: ['Ramsis'],
  isActive: false,
};
const UPDATE_STATION_REQUEST: UpdateStationRequest = {
  stationId: STATION_ID,
  aliases: { values: [] },
  isActive: false,
};
const STATION_RESPONSE: StationResponse = {
  station: {
    id: STATION_ID,
    cityId: request.destinationStationId,
    governorateId: request.travelClassId,
    name: { en: 'Ramses', ar: '\u0631\u0645\u0633\u064a\u0633' },
    cityName: { en: 'Cairo', ar: '\u0627\u0644\u0642\u0627\u0647\u0631\u0629' },
    governorateName: {
      en: 'Cairo',
      ar: '\u0627\u0644\u0642\u0627\u0647\u0631\u0629',
    },
    altSpellings: [],
    isActive: false,
    createdAt: '2026-11-13T01:00:00.000Z',
    updatedAt: '2026-11-13T01:15:00.000Z',
  },
};

/**
 * Typed, not `as never`: rxjs declares an `of(value: null)` overload, and
 * `never` is assignable to `null`, so an untyped stub made `of(RESPONSE)` an
 * `Observable<null>` that no longer matched the client's own signature.
 */
const RESPONSE: SearchOneWayTripsResponse = {
  dateStrip: [],
  trips: [],
  bookingWindow: {
    firstBookableDate: '2026-06-20',
    lastBookableDate: '2026-07-19',
    totalDays: 30,
  },
  evaluatedAt: {
    localDate: '2026-06-20',
    localTime: '09:00',
    utcOffset: '+03:00',
    iso: '2026-06-20T06:00:00.000Z',
    timeZone: 'Africa/Cairo',
  },
};

function clientWith(
  searchOneWayTrips: CatalogGrpcClient['searchOneWayTrips'],
): CatalogGrpcClientService {
  const cls = {
    get: () => undefined,
    set: () => undefined,
  } as unknown as ClsService;
  // These specs call only `searchOneWayTrips`; shared-path specs stub every RPC.
  return new CatalogGrpcClientService(
    { searchOneWayTrips } as CatalogGrpcClient,
    cls,
  );
}

/** Shared-path test client with all RPC methods stubbed. */
function clientForAll(
  stub: (name: string) => (...args: unknown[]) => Observable<unknown>,
  values: Record<string, unknown> = {},
): CatalogGrpcClientService {
  const cls = {
    get: (key: string) => values[key],
    set: () => undefined,
  } as unknown as ClsService;

  return new CatalogGrpcClientService(
    {
      listStations: stub('listStations'),
      getStation: stub('getStation'),
      createStation: stub('createStation'),
      updateStation: stub('updateStation'),
      deactivateStation: stub('deactivateStation'),
      searchOneWayTrips: stub('searchOneWayTrips'),
      searchReturnTrips: stub('searchReturnTrips'),
      getTripStops: stub('getTripStops'),
      listRecentSearches: stub('listRecentSearches'),
    } as unknown as CatalogGrpcClient,
    cls,
  );
}

describe('calling catalog over gRPC', () => {
  it('returns the response on success', async () => {
    const service = clientWith(() => of(RESPONSE));

    await expect(service.searchOneWayTrips(request)).resolves.toBe(RESPONSE);
  });

  /** Slow or stopped catalog calls must time out with a retryable error. */
  it('sends a deadline with every call', async () => {
    const spy = vi.fn().mockReturnValue(of(RESPONSE));
    const before = Date.now();

    await clientWith(spy as never).searchOneWayTrips(request);

    const options = spy.mock.calls[0][2] as CallOptions;
    expect(options.deadline).toBeGreaterThanOrEqual(
      before + CATALOG_SEARCH_TIMEOUT_MS,
    );
    expect(options.deadline).toBeLessThanOrEqual(
      Date.now() + CATALOG_SEARCH_TIMEOUT_MS,
    );
  });

  /** RxJS also times out channels that never emit a gRPC deadline error. */
  it(
    'gives up on a call that never answers, instead of hanging',
    async () => {
      // Simulate a catalog connection that never responds.
      const service = clientWith(() => new Observable<never>(() => {}));

      const error = await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpException);
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      const body = exception.getResponse() as {
        code: string;
        retryAfterSeconds?: number;
      };
      expect(body.code).toBe(ErrorCode.GATEWAY_TIMEOUT);
      // Tell the user to retry.
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    },
    CATALOG_SEARCH_TIMEOUT_MS + 2000,
  );

  describe('a transport failure', () => {
    it('maps a stopped catalog to 503 with a retry hint', async () => {
      // UNAVAILABLE.
      const service = clientWith(() => throwError(() => ({ code: 14 })));

      const error = (await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = error.getResponse() as {
        code: string;
        retryAfterSeconds?: number;
      };
      expect(body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('maps a server-side deadline to 504', async () => {
      // DEADLINE_EXCEEDED, as the channel reports it.
      const service = clientWith(() => throwError(() => ({ code: 4 })));

      const error = (await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    });
  });

  describe('a business refusal', () => {
    it('becomes the status its code maps to, with the fields intact', async () => {
      const service = clientWith(() =>
        throwError(() => ({
          code: 3, // INVALID_ARGUMENT
          details: JSON.stringify({
            code: ErrorCode.VALIDATION_ERROR,
            details: [
              {
                field: 'to',
                rejectedValue: 'x',
                issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
                actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
              },
            ],
          }),
        })),
      );

      const error = (await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      const body = error.getResponse() as {
        code: string;
        // Under `message`, because that is the channel the envelope filter
        // reads when turning an exception into error.details.
        message: ValidationIssueRef[];
      };
      expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(body.message[0].field).toBe('to');
      expect(body.message[0].rejectedValue).toBe('x');
      expect(body.message[0].issueKey).toBe('ISSUE_SAME_STATION_AS_ORIGIN');
      expect(body.message[0].actionKey).toBe(
        'ACTION_PICK_DIFFERENT_DESTINATION',
      );
    });

    // Unknown business codes fall back to transport status.
    it('ignores an unknown code and uses the transport status', async () => {
      const service = clientWith(() =>
        throwError(() => ({
          code: 14,
          details: JSON.stringify({ code: 'INVENTED_CODE' }),
        })),
      );

      const error = (await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = error.getResponse() as { code: string };
      expect(body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    });
  });
});

describe('calling the station picker over gRPC', () => {
  it('calls ListStations with the raw request and returns its response', async () => {
    const listStations = vi.fn().mockReturnValue(of(STATIONS_RESPONSE));
    const service = clientForAll(
      (name) =>
        name === 'listStations'
          ? listStations
          : () => throwError(() => new Error(`Unexpected ${name} call`)),
      { [CORRELATION_ID_KEY]: 'stations-correlation-id' },
    );

    await expect(service.listStations(STATIONS_REQUEST)).resolves.toBe(
      STATIONS_RESPONSE,
    );

    expect(listStations).toHaveBeenCalledTimes(1);
    expect(listStations.mock.calls[0][0]).toBe(STATIONS_REQUEST);
    const metadata = listStations.mock.calls[0][1] as Metadata;
    // A public picker still carries correlation, but cannot invent a caller.
    expect(metadata.getMap()).toEqual({
      [CORRELATION_ID_HEADER]: 'stations-correlation-id',
    });
  });

  it('times out and unsubscribes when ListStations never answers', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const unsubscribe = vi.fn();
      const service = clientForAll(
        () => () => new Observable<never>(() => unsubscribe),
      );

      void service.listStations(STATIONS_REQUEST).catch(onError);
      await vi.advanceTimersByTimeAsync(CATALOG_SEARCH_TIMEOUT_MS + 1000);

      // Check settlement before reading the error, so losing the timeout fails
      // immediately instead of awaiting a promise that will never settle.
      expect(onError).toHaveBeenCalledTimes(1);
      const error = onError.mock.calls[0][0] as HttpException;
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(error.getResponse()).toEqual({
        code: ErrorCode.GATEWAY_TIMEOUT,
        retryAfterSeconds: expect.any(Number),
      });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<ValidationIssueRef>([
    {
      field: 'lang',
      rejectedValue: 'fr',
      issueKey: 'ISSUE_STATION_LANGUAGE_INVALID',
      actionKey: 'ACTION_SET_STATION_LANGUAGE',
    },
    {
      field: 'query',
      rejectedValue: 'x'.repeat(101),
      issueKey: 'ISSUE_STATION_QUERY_TOO_LONG',
      actionKey: 'ACTION_SHORTEN_STATION_QUERY',
      params: { maxLength: '100' },
    },
  ])(
    'forwards the station $field refusal with its ref and value intact',
    async (detail) => {
      const service = clientForAll(
        () => () =>
          throwError(() => ({
            code: 3,
            details: JSON.stringify({
              code: ErrorCode.VALIDATION_ERROR,
              details: [detail],
            }),
          })),
      );

      const error = await service
        .listStations(STATIONS_REQUEST)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpException);
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(exception.getResponse()).toEqual({
        code: ErrorCode.VALIDATION_ERROR,
        message: [detail],
      });
    },
  );
});

describe('calling operator stations over the shared catalog client', () => {
  it.each([
    {
      name: 'getStation',
      data: { stationId: STATION_ID },
      key: undefined,
      invoke: (service: CatalogGrpcClientService) =>
        service.getStation(STATION_ID),
    },
    {
      name: 'createStation',
      data: CREATE_STATION_REQUEST,
      key: IDEMPOTENCY_KEY,
      invoke: (service: CatalogGrpcClientService) =>
        service.createStation(CREATE_STATION_REQUEST, IDEMPOTENCY_KEY),
    },
    {
      name: 'updateStation',
      data: UPDATE_STATION_REQUEST,
      key: IDEMPOTENCY_KEY,
      invoke: (service: CatalogGrpcClientService) =>
        service.updateStation(UPDATE_STATION_REQUEST, IDEMPOTENCY_KEY),
    },
    {
      name: 'deactivateStation',
      data: { stationId: STATION_ID },
      key: IDEMPOTENCY_KEY,
      invoke: (service: CatalogGrpcClientService) =>
        service.deactivateStation(STATION_ID, IDEMPOTENCY_KEY),
    },
  ])(
    '$name forwards its request and key without changing the response',
    async ({ name, data, key, invoke }) => {
      const rpc = vi.fn().mockReturnValue(of(STATION_RESPONSE));
      const service = clientForAll(
        (method) =>
          method === name
            ? rpc
            : () => throwError(() => new Error(`Unexpected ${method} call`)),
        { [CALLER_ACCOUNT_ID_KEY]: 'actual-operator-id' },
      );

      await expect(invoke(service)).resolves.toBe(STATION_RESPONSE);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0][0]).toStrictEqual(data);
      expect(rpc.mock.calls[0][0]).not.toHaveProperty('idempotencyKey');
      expect(rpc.mock.calls[0][0]).not.toHaveProperty('actorAccountId');
      const metadata = rpc.mock.calls[0][1] as Metadata;
      expect(metadata.get('idempotency-key')).toEqual(key ? [key] : []);
      expect(metadata.get(CALLER_ACCOUNT_ID_HEADER)).toEqual([
        'actual-operator-id',
      ]);
    },
  );

  it('creates fresh metadata so a write key cannot leak into a later detail read', async () => {
    const rpc = vi.fn().mockReturnValue(of(STATION_RESPONSE));
    const service = clientForAll(() => rpc);

    await service.createStation(CREATE_STATION_REQUEST, 'create-1');
    await service.updateStation(UPDATE_STATION_REQUEST, 'update-1');
    await service.getStation(STATION_ID);

    const metadata = rpc.mock.calls.map((call) => call[1] as Metadata);
    expect(metadata[0].get('idempotency-key')).toEqual(['create-1']);
    expect(metadata[1].get('idempotency-key')).toEqual(['update-1']);
    expect(metadata[2].get('idempotency-key')).toEqual([]);
    expect(new Set(metadata).size).toBe(3);
  });

  it.each([
    {
      invoke: (service: CatalogGrpcClientService) =>
        service.getStation(STATION_ID),
      code: ErrorCode.RESOURCE_NOT_FOUND,
      status: HttpStatus.NOT_FOUND,
      detail: {
        field: 'stationId',
        rejectedValue: STATION_ID,
        issueKey: 'ISSUE_STATION_NOT_FOUND',
        actionKey: 'ACTION_REFRESH_STATIONS',
      },
    },
    {
      invoke: (service: CatalogGrpcClientService) =>
        service.createStation(CREATE_STATION_REQUEST, IDEMPOTENCY_KEY),
      code: ErrorCode.VALIDATION_ERROR,
      status: HttpStatus.BAD_REQUEST,
      detail: {
        field: 'cityId',
        rejectedValue: CREATE_STATION_REQUEST.cityId,
        issueKey: 'ISSUE_STATION_CITY_NOT_KNOWN',
        actionKey: 'ACTION_PICK_STATION_CITY',
      },
    },
    {
      invoke: (service: CatalogGrpcClientService) =>
        service.updateStation({ stationId: STATION_ID }, IDEMPOTENCY_KEY),
      code: ErrorCode.VALIDATION_ERROR,
      status: HttpStatus.BAD_REQUEST,
      detail: {
        field: 'body',
        rejectedValue: {},
        issueKey: 'ISSUE_STATION_PATCH_EMPTY',
        actionKey: 'ACTION_SEND_STATION_CHANGES',
      },
    },
    {
      invoke: (service: CatalogGrpcClientService) =>
        service.deactivateStation(STATION_ID, IDEMPOTENCY_KEY),
      code: ErrorCode.RESOURCE_NOT_FOUND,
      status: HttpStatus.NOT_FOUND,
      detail: {
        field: 'stationId',
        rejectedValue: STATION_ID,
        issueKey: 'ISSUE_STATION_NOT_FOUND',
        actionKey: 'ACTION_REFRESH_STATIONS',
      },
    },
  ])(
    'decodes the agreed $detail.issueKey refusal without rule prose',
    async ({ invoke, code, status, detail }) => {
      const service = clientForAll(
        () => () =>
          throwError(() => ({
            code: 3,
            details: JSON.stringify({ code, details: [detail] }),
          })),
      );

      await expect(invoke(service)).rejects.toMatchObject({
        status,
        response: { code, message: [detail] },
      });
    },
  );
});

/**
 * Every method goes through one private `call`, so the deadline and the error
 * mapping cannot be forgotten on a new one. These specs are about that shared
 * path rather than about any single RPC.
 */
describe('every catalog call', () => {
  const invoke = (
    service: CatalogGrpcClientService,
    name: string,
  ): Promise<unknown> =>
    ({
      listStations: () => service.listStations(STATIONS_REQUEST),
      getStation: () => service.getStation(STATION_ID),
      createStation: () =>
        service.createStation(CREATE_STATION_REQUEST, IDEMPOTENCY_KEY),
      updateStation: () =>
        service.updateStation(UPDATE_STATION_REQUEST, IDEMPOTENCY_KEY),
      deactivateStation: () =>
        service.deactivateStation(STATION_ID, IDEMPOTENCY_KEY),
      searchOneWayTrips: () => service.searchOneWayTrips(request),
      searchReturnTrips: () =>
        service.searchReturnTrips({
          outboundTripId: '44444444-4444-4444-8444-444444444444',
          outboundOriginStationId: request.originStationId,
          outboundDestinationStationId: request.destinationStationId,
          returnDate: '2026-06-25',
          travelClassId: request.travelClassId,
        }),
      getTripStops: () =>
        service.getTripStops({
          tripId: '44444444-4444-4444-8444-444444444444',
          originStationId: request.originStationId,
          destinationStationId: request.destinationStationId,
        }),
      listRecentSearches: () => service.listRecentSearches({}),
    })[name]!();

  const METHODS = [
    'listStations',
    'getStation',
    'createStation',
    'updateStation',
    'deactivateStation',
    'searchOneWayTrips',
    'searchReturnTrips',
    'getTripStops',
    'listRecentSearches',
  ] as const;

  it.each(METHODS)('carries a deadline on %s', async (name) => {
    const seen: CallOptions[] = [];
    const service = clientForAll(() => (_data, _metadata, options) => {
      seen.push(options as CallOptions);
      return of({});
    });
    const before = Date.now();

    await invoke(service, name);

    const deadline = seen[0].deadline as number;
    expect(deadline).toBeGreaterThanOrEqual(before + CATALOG_SEARCH_TIMEOUT_MS);
    expect(deadline).toBeLessThanOrEqual(
      Date.now() + CATALOG_SEARCH_TIMEOUT_MS,
    );
  });

  it.each(METHODS)(
    'carries caller and correlation metadata on %s',
    async (name) => {
      const seen: Metadata[] = [];
      const service = clientForAll(
        () => (_data, metadata) => {
          seen.push(metadata as Metadata);
          return of({});
        },
        {
          [CORRELATION_ID_KEY]: 'catalog-correlation-id',
          [CALLER_ACCOUNT_ID_KEY]: 'account-1',
          [CALLER_SESSION_ID_KEY]: 'session-1',
          [CALLER_JTI_KEY]: 'jti-1',
          [CALLER_ROLES_KEY]: ['operator'],
          [CALLER_BOOKABLE_KEY]: false,
        },
      );

      await invoke(service, name);

      expect(seen).toHaveLength(1);
      const metadata = seen[0];
      expect(metadata).toBeInstanceOf(Metadata);
      expect(metadata.get(CORRELATION_ID_HEADER)).toEqual([
        'catalog-correlation-id',
      ]);
      expect(metadata.get(CALLER_ACCOUNT_ID_HEADER)).toEqual(['account-1']);
      expect(metadata.get(CALLER_SESSION_ID_HEADER)).toEqual(['session-1']);
      expect(metadata.get(CALLER_JTI_HEADER)).toEqual(['jti-1']);
      expect(metadata.get(CALLER_ROLES_HEADER)).toEqual(['operator']);
      expect(metadata.get(CALLER_BOOKABLE_HEADER)).toEqual(['false']);
      expect(metadata.get('idempotency-key')).toEqual(
        ['createStation', 'updateStation', 'deactivateStation'].includes(name)
          ? [IDEMPOTENCY_KEY]
          : [],
      );
    },
  );

  it.each(METHODS)('times out locally and unsubscribes on %s', async (name) => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const unsubscribe = vi.fn();
      const service = clientForAll(
        () => () => new Observable<never>(() => unsubscribe),
      );
      void invoke(service, name).catch(onError);

      await vi.advanceTimersByTimeAsync(CATALOG_SEARCH_TIMEOUT_MS + 1000);

      expect(onError).toHaveBeenCalledTimes(1);
      const exception = onError.mock.calls[0][0] as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(exception.getResponse()).toEqual({
        code: ErrorCode.GATEWAY_TIMEOUT,
        retryAfterSeconds: expect.any(Number),
      });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(METHODS)('maps an unavailable catalog to 503 on %s', async (name) => {
    const service = clientForAll(() => () => throwError(() => ({ code: 14 })));

    const error = (await invoke(service, name).catch(
      (caught: unknown) => caught,
    )) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    const body = error.getResponse() as {
      code: string;
      retryAfterSeconds: number;
    };
    expect(body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it.each(METHODS)('maps a deadline to 504 on %s', async (name) => {
    const service = clientForAll(() => () => throwError(() => ({ code: 4 })));

    const error = (await invoke(service, name).catch(
      (caught: unknown) => caught,
    )) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    const body = error.getResponse() as {
      code: string;
      retryAfterSeconds: number;
    };
    expect(body.code).toBe(ErrorCode.GATEWAY_TIMEOUT);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it.each(METHODS)(
    'falls back to transport for an unknown business code on %s',
    async (name) => {
      const service = clientForAll(
        () => () =>
          throwError(() => ({
            code: 14,
            details: JSON.stringify({ code: 'INVENTED_CODE' }),
          })),
      );

      const error = (await invoke(service, name).catch(
        (caught: unknown) => caught,
      )) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(error.getResponse()).toEqual({
        code: ErrorCode.SERVICE_UNAVAILABLE,
        retryAfterSeconds: expect.any(Number),
      });
    },
  );

  it.each(METHODS)(
    'maps an unknown transport status to a safe 500 on %s',
    async (name) => {
      const service = clientForAll(
        () => () =>
          throwError(() => ({
            code: 999,
            details: 'private transport diagnostic',
          })),
      );

      const error = (await invoke(service, name).catch(
        (caught: unknown) => caught,
      )) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(error.getResponse()).toEqual({
        code: ErrorCode.INTERNAL_SERVER_ERROR,
      });
    },
  );

  // A refusal from catalog keeps its business code whichever call produced it.
  it.each(METHODS)('restores a business refusal on %s', async (name) => {
    const detail: ValidationIssueRef = {
      field: 'tripId',
      rejectedValue: 'missing-trip',
      issueKey: 'ISSUE_OUTBOUND_TRIP_GONE',
      actionKey: 'ACTION_PICK_TRIP_FROM_RESULTS',
    };
    const service = clientForAll(
      () => () =>
        throwError(() => ({
          code: 3,
          details: JSON.stringify({
            code: ErrorCode.RESOURCE_NOT_FOUND,
            details: [detail],
          }),
        })),
    );

    const error = (await invoke(service, name).catch(
      (caught: unknown) => caught,
    )) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toEqual({
      code: ErrorCode.RESOURCE_NOT_FOUND,
      message: [detail],
    });
  });
});
