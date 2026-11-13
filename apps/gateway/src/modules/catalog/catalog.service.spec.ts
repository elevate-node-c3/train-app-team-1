import type {
  CreateStationRequest,
  ListStationsRequest,
  ListStationsResponse,
  SearchOneWayTripsResponse,
  SearchReturnTripsResponse,
  StationResponse,
  UpdateStationRequest,
} from '@app/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CatalogGrpcClientService } from './catalog.grpc.client.js';
import { CatalogService } from './catalog.service.js';
import type { SearchReturnTripsDto } from './dto/search-return-trips.dto.js';
import type { SearchTripsDto } from './dto/search-trips.dto.js';
import type { UpdateStationDto } from './dto/station-requests.dto.js';
import type { TripStopsQueryDto } from './dto/trip-stops.dto.js';

const CAIRO = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';

const query = (overrides: Partial<SearchTripsDto> = {}): SearchTripsDto =>
  ({
    from: CAIRO,
    to: ALEX,
    departureDate: '2026-06-20',
    travelClassId: FIRST,
    ...overrides,
  }) as SearchTripsDto;

const baseResponse: SearchOneWayTripsResponse = {
  dateStrip: [
    { date: '2026-06-20', selected: true, isToday: false, bookable: true },
  ],
  trips: [],
  bookingWindow: {
    firstBookableDate: '2026-06-15',
    lastBookableDate: '2026-07-14',
    totalDays: 30,
  },
  evaluatedAt: {
    localDate: '2026-06-15',
    localTime: '12:00',
    utcOffset: '+03:00',
    iso: '2026-06-15T12:00:00+03:00',
    timeZone: 'Africa/Cairo',
  },
};

function serviceWith(response: SearchOneWayTripsResponse) {
  const searchOneWayTrips = vi.fn().mockResolvedValue(response);
  const client = { searchOneWayTrips } as unknown as CatalogGrpcClientService;

  return { service: new CatalogService(client), searchOneWayTrips };
}

describe('the gateway search service', () => {
  describe('the request it sends', () => {
    it('maps the query onto the wire names', async () => {
      const { service, searchOneWayTrips } = serviceWith(baseResponse);

      await service.searchOneWay(query(), 'en');

      expect(searchOneWayTrips).toHaveBeenCalledWith({
        originStationId: CAIRO,
        destinationStationId: ALEX,
        departureDate: '2026-06-20',
        travelClassId: FIRST,
      });
    });

    // Absent stays absent rather than becoming 0 or an empty string: catalog
    // distinguishes "any train" from a train number.
    it('omits an absent train number and language', async () => {
      const { service, searchOneWayTrips } = serviceWith(baseResponse);

      await service.searchOneWay(query(), 'ar');

      const sent = searchOneWayTrips.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect('trainNumber' in sent).toBe(false);
      expect('language' in sent).toBe(false);
    });

    it('forwards a train number and the declared language when given', async () => {
      const { service, searchOneWayTrips } = serviceWith(baseResponse);

      await service.searchOneWay(
        query({ trainNumber: 903, language: 'en' }),
        'en',
      );

      const sent = searchOneWayTrips.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(sent.trainNumber).toBe(903);
      expect(sent.language).toBe('en');
    });

    describe('the filters and the order', () => {
      it('sends no filters object when nothing was narrowed', async () => {
        const { service, searchOneWayTrips } = serviceWith(baseResponse);

        await service.searchOneWay(query(), 'en');

        const sent = searchOneWayTrips.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        // Absent rather than `{}`: "no filters" stays legible in a log.
        expect('filters' in sent).toBe(false);
        expect('sort' in sent).toBe(false);
      });

      it('maps each filter onto its wire name', async () => {
        const { service, searchOneWayTrips } = serviceWith(baseResponse);

        await service.searchOneWay(
          query({
            trainTypeIds: [FIRST],
            departAfter: 360,
            departBefore: 750,
            maxFare: 15_500,
            excludeSoldOut: true,
            sort: 'SEARCH_SORT_FARE_ASC',
          }),
          'en',
        );

        const sent = searchOneWayTrips.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(sent.sort).toBe('SEARCH_SORT_FARE_ASC');
        expect(sent.filters).toEqual({
          trainTypeIds: [FIRST],
          departAfterMinutes: 360,
          departBeforeMinutes: 750,
          maxFareMinor: 15_500,
          excludeSoldOut: true,
        });
      });

      it('sends only the filters the traveller set', async () => {
        const { service, searchOneWayTrips } = serviceWith(baseResponse);

        await service.searchOneWay(query({ maxFare: 9_000 }), 'en');

        const sent = searchOneWayTrips.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(sent.filters).toEqual({ maxFareMinor: 9_000 });
      });

      // `false` is a choice the traveller made, not an absent filter.
      it('forwards excludeSoldOut=false rather than dropping it', async () => {
        const { service, searchOneWayTrips } = serviceWith(baseResponse);

        await service.searchOneWay(query({ excludeSoldOut: false }), 'en');

        const sent = searchOneWayTrips.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(sent.filters).toEqual({ excludeSoldOut: false });
      });

      it('forwards a return date when the traveller is planning a round trip', async () => {
        const { service, searchOneWayTrips } = serviceWith(baseResponse);

        await service.searchOneWay(query({ returnDate: '2026-06-25' }), 'en');

        const sent = searchOneWayTrips.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(sent.returnDate).toBe('2026-06-25');
      });
    });
  });

  describe('the response it returns', () => {
    it('passes the strip, window and trips through untouched', async () => {
      const { service } = serviceWith(baseResponse);

      const result = await service.searchOneWay(query(), 'en');

      expect(result.dateStrip).toEqual(baseResponse.dateStrip);
      expect(result.bookingWindow).toEqual(baseResponse.bookingWindow);
      expect(result.evaluatedAt).toEqual(baseResponse.evaluatedAt);
    });

    /**
     * proto3 omits an empty repeated field, so a day with no trips comes back
     * with no `trips` key at all. A REST client must not have to know that
     * absent means empty -- that is the difference between "no trains" and
     * "the server forgot to tell me".
     */
    it('turns an omitted empty array back into an empty array', async () => {
      const { service } = serviceWith({
        ...baseResponse,
        trips: undefined as never,
        dateStrip: undefined as never,
        emptyResult: {
          reason: 'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE' as never,
          params: {},
        },
      });

      const result = await service.searchOneWay(query(), 'en');

      expect(result.trips).toEqual([]);
      expect(result.dateStrip).toEqual([]);
    });

    /**
     * The facets have the same problem twice over: `trainTypes` is a repeated
     * field, so an empty one arrives as no key and a client reading `.length`
     * would throw, and an int32 of 0 is omitted too -- which would otherwise
     * be indistinguishable from a free trip.
     */
    it('always answers with a filterOptions object', async () => {
      const { service } = serviceWith({
        ...baseResponse,
        filterOptions: undefined as never,
      });

      const result = await service.searchOneWay(query(), 'en');

      expect(result.filterOptions).toEqual({
        trainTypes: [],
        minFareMinor: 0,
        maxFareMinor: 0,
      });
    });

    it('passes the day facets through when catalog sent them', async () => {
      const filterOptions = {
        trainTypes: [
          { id: FIRST, name: { en: 'Express', ar: 'مميز' }, tripCount: 3 },
        ],
        minFareMinor: 9_000,
        maxFareMinor: 20_000,
      };
      const { service } = serviceWith({ ...baseResponse, filterOptions });

      const result = await service.searchOneWay(query(), 'en');

      expect(result.filterOptions).toEqual(filterOptions);
    });

    it('carries no empty result when there are trips', async () => {
      const { service } = serviceWith({
        ...baseResponse,
        trips: [{ tripId: 'a' } as never],
      });

      const result = await service.searchOneWay(query(), 'en');

      expect(result.emptyResult).toBeUndefined();
    });
  });

  /**
   * Catalog returns a reason and the values; the words are chosen here. That
   * is what keeps catalog free of any language, and it is why the catalogue is
   * keyed by the wire enum -- there is no mapping table in between.
   */
  describe('the empty-result sentence', () => {
    const withReason = (reason: string, params: Record<string, string> = {}) =>
      serviceWith({
        ...baseResponse,
        emptyResult: { reason: reason as never, params },
      });

    it('speaks English when asked to', async () => {
      const { service } = withReason('SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE');

      const result = await service.searchOneWay(query(), 'en');

      expect(result.emptyResult?.message).toBe(
        'Sorry, no trains available on the selected date',
      );
    });

    it('speaks Arabic when asked to', async () => {
      const { service } = withReason('SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE');

      const result = await service.searchOneWay(query(), 'ar');

      expect(result.emptyResult?.message).toBe(
        'عفوا, لا يوجد مواعيد متاحة في التاريخ المختار',
      );
    });

    it('keeps the reason beside the sentence, so a client can branch on it', async () => {
      const { service } = withReason('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED');

      const result = await service.searchOneWay(query(), 'en');

      expect(result.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED',
      );
    });

    // Each reason points at a different field to change (BR-57), so no two may
    // render the same sentence.
    it('says something different for each of the three reasons', async () => {
      const messages: string[] = [];

      for (const reason of [
        'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED',
        'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE',
        'SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE',
      ]) {
        const { service } = withReason(reason);
        const result = await service.searchOneWay(query(), 'en');
        messages.push(result.emptyResult!.message);
      }

      expect(new Set(messages).size).toBe(3);
    });

    it('tolerates an absent params map', async () => {
      const { service } = serviceWith({
        ...baseResponse,
        emptyResult: {
          reason: 'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE' as never,
          params: undefined as never,
        },
      });

      const result = await service.searchOneWay(query(), 'en');

      expect(result.emptyResult?.message).not.toBe('');
    });
  });
});

describe('the gateway station-picker service', () => {
  function serviceWith(response: Partial<ListStationsResponse>) {
    const listStations = vi.fn().mockResolvedValue(response);
    const client = { listStations } as unknown as CatalogGrpcClientService;

    return { service: new CatalogService(client), listStations };
  }

  it.each<ListStationsRequest>([
    { language: 'en', query: '  RaMsEs  ' },
    { language: 'ar', query: '' },
    { language: ' EN ', query: 'x'.repeat(101) },
    { language: '' },
    { language: 'fr', query: '  ' },
  ])(
    'forwards language and query without rewriting them: %j',
    async (request) => {
      Object.freeze(request);
      const { service, listStations } = serviceWith({ governorates: [] });

      await service.listStations(request);

      expect(listStations).toHaveBeenCalledTimes(1);
      expect(listStations.mock.calls[0][0]).toStrictEqual(request);
    },
  );

  it('restores an omitted governorates array without mutating the response', async () => {
    const response = Object.freeze({});
    const { service } = serviceWith(response);

    await expect(service.listStations({ language: 'en' })).resolves.toEqual({
      governorates: [],
    });
    expect(response).not.toHaveProperty('governorates');
  });

  it('keeps an explicitly empty governorates array empty', async () => {
    const response: ListStationsResponse = { governorates: [] };
    Object.freeze(response.governorates);
    Object.freeze(response);
    const { service } = serviceWith(response);

    await expect(service.listStations({ language: 'ar' })).resolves.toEqual({
      governorates: [],
    });
    expect(response).toStrictEqual({ governorates: [] });
  });

  it('restores nested absent stations while preserving populated groups and the original response', async () => {
    const emptyGovernorate = Object.freeze({ id: FIRST, name: 'Cairo' });
    const populatedGovernorate = {
      id: ALEX,
      name: 'Alexandria',
      stations: [
        { id: CAIRO, name: 'Sidi Gaber', cityName: 'Alexandria' },
        { id: FIRST, name: 'Misr', cityName: 'Alexandria' },
      ],
    };
    const response = {
      governorates: [emptyGovernorate, populatedGovernorate],
    };
    const original = structuredClone(response);
    Object.freeze(response.governorates);
    Object.freeze(response);
    // An empty repeated stations field can be truly absent after decoding.
    const { service } = serviceWith(response as ListStationsResponse);

    const result = await service.listStations({ language: 'en', query: '' });

    expect(result).toStrictEqual({
      governorates: [
        { id: FIRST, name: 'Cairo', stations: [] },
        populatedGovernorate,
      ],
    });
    expect(emptyGovernorate).not.toHaveProperty('stations');
    expect(response).toStrictEqual(original);
  });

  it('does not turn a failed catalog call into an empty station list', async () => {
    const failure = new Error('catalog refused');
    const { service, listStations } = serviceWith({});
    listStations.mockRejectedValue(failure);

    await expect(service.listStations({ language: 'en' })).rejects.toBe(
      failure,
    );
  });
});

describe('the gateway operator station service', () => {
  const response: StationResponse = {
    station: {
      id: CAIRO,
      cityId: ALEX,
      governorateId: FIRST,
      name: { en: 'Ramses', ar: 'رمسيس' },
      cityName: { en: 'Cairo', ar: 'القاهرة' },
      governorateName: { en: 'Cairo', ar: 'القاهرة' },
      altSpellings: [],
      isActive: false,
      createdAt: '2026-11-13T01:00:00.000Z',
      updatedAt: '2026-11-13T01:15:00.000Z',
    },
  };

  function serviceWith() {
    const client = {
      getStation: vi.fn().mockResolvedValue(response),
      createStation: vi.fn().mockResolvedValue(response),
      updateStation: vi.fn().mockResolvedValue(response),
      deactivateStation: vi.fn().mockResolvedValue(response),
    };
    return {
      service: new CatalogService(
        client as unknown as CatalogGrpcClientService,
      ),
      client,
    };
  }

  it('fetches details by ID without filtering or localizing an inactive station', async () => {
    const { service, client } = serviceWith();

    await expect(service.getStation(CAIRO)).resolves.toBe(response);
    expect(client.getStation).toHaveBeenCalledWith(CAIRO);
    expect(response.station.isActive).toBe(false);
  });

  it.each<CreateStationRequest>([
    { cityId: ALEX, nameAr: 'رمسيس', nameEn: 'Ramses' },
    {
      cityId: ALEX,
      nameAr: 'رمسيس',
      nameEn: 'Ramses',
      altSpellings: [],
      isActive: false,
    },
    {
      cityId: ALEX,
      nameAr: 'رمسيس',
      nameEn: 'Ramses',
      altSpellings: ['Ramsis'],
      isActive: true,
    },
  ])(
    'passes creates and their direct altSpellings through: %j',
    async (body) => {
      const { service, client } = serviceWith();
      Object.freeze(body);

      await expect(service.createStation(body, 'create-key')).resolves.toBe(
        response,
      );
      expect(client.createStation).toHaveBeenCalledWith(body, 'create-key');
      expect(client.createStation.mock.calls[0][0]).toBe(body);
      expect(client.createStation.mock.calls[0][0]).not.toHaveProperty(
        'aliases',
      );
    },
  );

  it.each<{
    body: UpdateStationDto;
    changes: Omit<UpdateStationRequest, 'stationId'>;
  }>([
    { body: {}, changes: {} },
    { body: { cityId: ALEX }, changes: { cityId: ALEX } },
    { body: { nameAr: 'رمسيس' }, changes: { nameAr: 'رمسيس' } },
    { body: { nameEn: 'Ramses' }, changes: { nameEn: 'Ramses' } },
    { body: { isActive: true }, changes: { isActive: true } },
    { body: { isActive: false }, changes: { isActive: false } },
    { body: { altSpellings: [] }, changes: { aliases: { values: [] } } },
    {
      body: { altSpellings: ['Ramsis', 'Cairo'], isActive: false },
      changes: { aliases: { values: ['Ramsis', 'Cairo'] }, isActive: false },
    },
    {
      body: {
        cityId: ALEX,
        nameAr: 'رمسيس',
        nameEn: 'Ramses',
        altSpellings: ['Ramsis'],
        isActive: false,
      },
      changes: {
        cityId: ALEX,
        nameAr: 'رمسيس',
        nameEn: 'Ramses',
        aliases: { values: ['Ramsis'] },
        isActive: false,
      },
    },
    {
      body: {
        cityId: undefined,
        nameAr: undefined,
        nameEn: undefined,
        altSpellings: undefined,
        isActive: undefined,
      },
      changes: {},
    },
  ])('maps only supplied PATCH changes: $body', async ({ body, changes }) => {
    const { service, client } = serviceWith();
    const original = structuredClone(body);
    Object.freeze(body);

    await expect(
      service.updateStation(CAIRO, body, 'update-key'),
    ).resolves.toBe(response);

    expect(client.updateStation).toHaveBeenCalledTimes(1);
    expect(client.updateStation).toHaveBeenCalledWith(
      { stationId: CAIRO, ...changes },
      'update-key',
    );
    expect(client.updateStation.mock.calls[0][0]).not.toHaveProperty(
      'altSpellings',
    );
    expect(body).toStrictEqual(original);
  });

  it('does not turn inherited altSpellings into an explicit alias replacement', async () => {
    const { service, client } = serviceWith();
    const body = Object.create({
      altSpellings: ['inherited'],
    }) as UpdateStationDto;

    await service.updateStation(CAIRO, body, 'update-key');

    expect(client.updateStation).toHaveBeenCalledWith(
      { stationId: CAIRO },
      'update-key',
    );
  });

  it('forwards deactivation by ID and key and returns the retained station snapshot', async () => {
    const { service, client } = serviceWith();

    await expect(
      service.deactivateStation(CAIRO, 'deactivate-key'),
    ).resolves.toBe(response);
    expect(client.deactivateStation).toHaveBeenCalledWith(
      CAIRO,
      'deactivate-key',
    );
    expect(response.station.id).toBe(CAIRO);
    expect(response.station.isActive).toBe(false);
  });

  it.each([
    'getStation',
    'createStation',
    'updateStation',
    'deactivateStation',
  ] as const)('does not conceal a failed %s call', async (method) => {
    const { service, client } = serviceWith();
    const failure = new Error('catalog refused station command');
    client[method].mockRejectedValue(failure);
    const invoke = {
      getStation: () => service.getStation(CAIRO),
      createStation: () =>
        service.createStation(
          { cityId: ALEX, nameAr: 'رمسيس', nameEn: 'Ramses' },
          'key',
        ),
      updateStation: () => service.updateStation(CAIRO, {}, 'key'),
      deactivateStation: () => service.deactivateStation(CAIRO, 'key'),
    };

    await expect(invoke[method]()).rejects.toBe(failure);
  });
});

describe('the gateway return-search service', () => {
  const returnQuery = (
    overrides: Partial<SearchReturnTripsDto> = {},
  ): SearchReturnTripsDto =>
    ({
      outboundTripId: '44444444-4444-4444-8444-444444444444',
      outboundFrom: CAIRO,
      outboundTo: ALEX,
      returnDate: '2026-06-25',
      travelClassId: FIRST,
      ...overrides,
    }) as SearchReturnTripsDto;

  const returnResponse: SearchReturnTripsResponse = {
    trips: [],
    evaluatedAt: baseResponse.evaluatedAt,
    filterOptions: { trainTypes: [], minFareMinor: 0, maxFareMinor: 0 },
  };

  function serviceWith(response: SearchReturnTripsResponse) {
    const searchReturnTrips = vi.fn().mockResolvedValue(response);
    const client = { searchReturnTrips } as unknown as CatalogGrpcClientService;

    return { service: new CatalogService(client), searchReturnTrips };
  }

  it('maps the query onto the wire names', async () => {
    const { service, searchReturnTrips } = serviceWith(returnResponse);

    await service.searchReturn(returnQuery(), 'en');

    expect(searchReturnTrips).toHaveBeenCalledWith({
      outboundTripId: returnQuery().outboundTripId,
      outboundOriginStationId: CAIRO,
      outboundDestinationStationId: ALEX,
      returnDate: '2026-06-25',
      travelClassId: FIRST,
    });
  });

  it('forwards the filters and the order, as the outbound leg does', async () => {
    const { service, searchReturnTrips } = serviceWith(returnResponse);

    await service.searchReturn(
      returnQuery({ maxFare: 9_000, sort: 'SEARCH_SORT_FARE_ASC' }),
      'en',
    );

    const sent = searchReturnTrips.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.sort).toBe('SEARCH_SORT_FARE_ASC');
    expect(sent.filters).toEqual({ maxFareMinor: 9_000 });
  });

  // The outbound call already sent the strip and the window; two copies could
  // disagree, so this response carries neither.
  it('answers without a date strip or booking window', async () => {
    const { service } = serviceWith(returnResponse);

    const result = await service.searchReturn(returnQuery(), 'en');

    expect(result).not.toHaveProperty('dateStrip');
    expect(result).not.toHaveProperty('bookingWindow');
  });

  it('explains an empty list in the requested language', async () => {
    const { service } = serviceWith({
      ...returnResponse,
      trips: undefined as never,
      emptyResult: {
        reason: 'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL' as never,
        params: { outboundArrivalTime: '23:50' },
      },
    });

    const english = await service.searchReturn(returnQuery(), 'en');

    expect(english.trips).toEqual([]);
    expect(english.emptyResult?.reason).toBe(
      'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL',
    );
    // The arrival the server read is quoted back, so the traveller knows what
    // they are working around.
    expect(english.emptyResult?.message).toContain('23:50');
    expect(english.emptyResult?.message).toContain('return date');
  });

  it('answers in Arabic by default', async () => {
    const { service } = serviceWith({
      ...returnResponse,
      emptyResult: {
        reason: 'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL' as never,
        params: { outboundArrivalTime: '23:50' },
      },
    });

    const arabic = await service.searchReturn(returnQuery(), 'ar');

    expect(arabic.emptyResult?.message).toContain('العودة');
  });
});

describe('the gateway stops service', () => {
  const stopsQuery = { from: CAIRO, to: ALEX } as TripStopsQueryDto;
  const tripId = '44444444-4444-4444-8444-444444444444';

  it('maps the path id and the pair onto the wire names', async () => {
    const getTripStops = vi.fn().mockResolvedValue({ stops: [] });
    const service = new CatalogService({
      getTripStops,
    } as unknown as CatalogGrpcClientService);

    await service.tripStops(tripId, stopsQuery);

    expect(getTripStops).toHaveBeenCalledWith({
      tripId,
      originStationId: CAIRO,
      destinationStationId: ALEX,
    });
  });

  it('always answers with a stops array', async () => {
    const getTripStops = vi.fn().mockResolvedValue({});
    const service = new CatalogService({
      getTripStops,
    } as unknown as CatalogGrpcClientService);

    await expect(service.tripStops(tripId, stopsQuery)).resolves.toEqual({
      stops: [],
    });
  });
});

describe('the gateway recent-searches service', () => {
  it('sends no account, because the traveller is the token', async () => {
    const listRecentSearches = vi
      .fn()
      .mockResolvedValue({ recentSearches: [] });
    const service = new CatalogService({
      listRecentSearches,
    } as unknown as CatalogGrpcClientService);

    await service.recentSearches({});

    // An empty request: catalog reads the caller from gRPC metadata.
    expect(listRecentSearches).toHaveBeenCalledWith({});
  });

  it('forwards the declared language preference when given', async () => {
    const listRecentSearches = vi
      .fn()
      .mockResolvedValue({ recentSearches: [] });
    const service = new CatalogService({
      listRecentSearches,
    } as unknown as CatalogGrpcClientService);

    await service.recentSearches({ language: 'en' });

    expect(listRecentSearches).toHaveBeenCalledWith({ language: 'en' });
  });

  it('always answers with an array', async () => {
    const listRecentSearches = vi.fn().mockResolvedValue({});
    const service = new CatalogService({
      listRecentSearches,
    } as unknown as CatalogGrpcClientService);

    await expect(service.recentSearches({})).resolves.toEqual({
      recentSearches: [],
    });
  });
});
