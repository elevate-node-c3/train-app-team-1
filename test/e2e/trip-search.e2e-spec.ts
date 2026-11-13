import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResponse, ListStationsResponse } from '@app/contracts';

import {
  EMAIL_QUEUE,
  GATEWAY_URL,
  compose,
  redisGet,
  stopStack,
  waitFor,
  waitForConsumer,
  waitForGateway,
  waitForServiceReady,
} from './support/stack.js';
import {
  recentSearches,
  searchReturnTrips,
  searchTrips,
  startSearchStack,
  travellerAccessToken,
  tripStops,
} from './support/search-stack.js';
import {
  clearRecentSearches,
  seedSearchE2e,
  type E2eSearchFixture,
} from '../../apps/catalog/src/database/seeds/today-trips.js';

/**
 * Real HTTP tests cover authentication, retryable catalog failures, Redis
 * fallback and searching while identity is down.
 * Integration tests use a frozen clock for the 15-minute sales-close boundary,
 * Cairo date at the passenger origin on overnight trips, and the fare in force;
 * real HTTP requests cannot control now.
 */

const TRIPS = '/api/v1/trips/search';
const DETAIL_LANGUAGE_HEADERS = [
  undefined,
  'ar-EG,en;q=0.9',
  'en-GB,en;q=0.9',
] as const;

interface SearchBody {
  dateStrip: { date: string; selected: boolean; isToday: boolean }[];
  trips: {
    tripId: string;
    trainNumber: number;
    trainType: { en: string; ar: string };
    departure: {
      stationId: string;
      at: {
        localDate: string;
        localTime: string;
        utcOffset: string;
        timeZone: string;
      };
    };
    arrival: { at: { localDate: string; localTime: string } };
    durationMinutes: number;
    intermediateStops: number;
    availableSeats: number;
    soldOut: boolean;
    fare: { amountMinor: number; currency: string };
  }[];
  bookingWindow: {
    firstBookableDate: string;
    lastBookableDate: string;
    totalDays: number;
  };
  evaluatedAt: { timeZone: string };
  emptyResult?: { reason: string; message: string };
  /** Options for the unfiltered day. */
  filterOptions: {
    trainTypes: {
      id: string;
      name: { en: string; ar: string };
      tripCount: number;
    }[];
    minFareMinor: number;
    maxFareMinor: number;
  };
}

/**
 * Share one stack across suites: suite-level afterAll would tear it down
 * before the next suite, and startSearchStack wipes volumes and rebuilds.
 */
let fixture: E2eSearchFixture;
let token: string;
/** Separate account for the search-isolation checks. */
let otherToken: string;

beforeAll(async () => {
  startSearchStack();
  await waitForGateway();
  await waitForServiceReady('identity');
  await waitForServiceReady('catalog');

  // Wait for notification's subscription before requesting a verification email.
  await waitForServiceReady('notification');
  await waitForConsumer(EMAIL_QUEUE);

  // Seed through the host port after catalog has created the tables.
  fixture = await seedSearchE2e();
  token = await travellerAccessToken();
  otherToken = await travellerAccessToken();
}, 1_800_000);

afterAll(() => {
  stopStack();
}, 300_000);

describe('public station picker', () => {
  async function stations(
    acceptLanguage?: string,
    query = 'Ramsis',
    lang?: string,
  ) {
    const search = new URLSearchParams({ query });
    if (lang !== undefined) search.set('lang', lang);
    const response = await fetch(`${GATEWAY_URL}/api/v1/stations?${search}`, {
      headers:
        acceptLanguage === undefined
          ? {}
          : { 'Accept-Language': acceptLanguage },
    });
    return {
      status: response.status,
      body: (await response.json()) as ApiResponse<ListStationsResponse>,
    };
  }

  it.each([
    ['en', 'en'],
    ['ar', 'ar'],
    [undefined, 'ar'],
    ['fr', 'ar'],
    ['*', 'ar'],
    ['en-GB,en;q=0.9', 'en'],
  ] as const)(
    'uses Accept-Language %s without requiring a bearer token',
    async (header, language) => {
      const { status, body } = await stations(header);
      expect(status, JSON.stringify(body.error)).toBe(200);
      const station = body.data?.governorates
        .flatMap((group) => group.stations)
        .find((entry) => entry.id === fixture.stations.ramsis);
      expect(station).toBeDefined();
      if (language === 'en') expect(station?.name).toMatch(/rams[ei]s/i);
      else expect(station?.name).not.toMatch(/[A-Za-z]/);
      expect(station?.cityName).not.toBe('');
    },
  );

  it('ignores a lang query parameter in favor of the language header', async () => {
    const { status, body } = await stations('ar', 'Ramsis', 'en');
    expect(status).toBe(200);
    const station = body.data?.governorates
      .flatMap((group) => group.stations)
      .find((entry) => entry.id === fixture.stations.ramsis);
    expect(station?.name).not.toMatch(/[A-Za-z]/);
  });

  it("stores the bilingual city hierarchy in dev's canonical station cache", async () => {
    await stations('en');
    await stations('ar');
    // The seed invalidates, so the live generation decides which key holds it.
    const generation = redisGet('catalog:stations:generation') || '1';
    const cached = JSON.parse(redisGet(`catalog:stations:v1:g${generation}`)!);
    const city = cached.governorates[0].cities[0];
    expect(city.name.en).toBeTypeOf('string');
    expect(city.name.ar).toBeTypeOf('string');
    expect(city.stations[0].name.en).toBeTypeOf('string');
    expect(city.stations[0].name.ar).toBeTypeOf('string');
    expect(redisGet('catalog:stations:list:v1')).toBeNull();
  });

  it('returns a localized field refusal for an overlong search', async () => {
    const query = 'x'.repeat(101);
    const { status, body } = await stations('en', query);
    expect(status).toBe(400);
    expect(body.error?.details?.[0]).toMatchObject({
      field: 'query',
      rejectedValue: query,
    });
    expect(body.error?.details?.[0].issue).toContain('100');
    expect(body.error?.details?.[0].action).toContain('100');
    expect(JSON.stringify(body.error?.details)).not.toMatch(
      /issueKey|actionKey|\{\{/,
    );
  });
});

describe('One-way search, edge to catalog', () => {
  const search = (
    query: Parameters<typeof searchTrips>[0] = {},
    options: Parameters<typeof searchTrips>[1] = {},
  ) =>
    searchTrips(
      {
        from: fixture.stations.alexandria,
        to: fixture.stations.ramsis,
        departureDate: fixture.searchDate,
        travelClassId: fixture.travelClasses.first,
        ...query,
      },
      { token, ...options },
    );

  describe('the happy path', () => {
    it('returns the trip with everything BR-17 requires', async () => {
      const { status, body } = await search();

      expect(status, JSON.stringify(body.error)).toBe(200);
      const data = body.data as SearchBody;

      expect(data.trips).toHaveLength(1);
      const [trip] = data.trips;

      expect(trip.trainNumber).toBe(fixture.trainNumbers.mainLine);
      expect(trip.trainType.en).toBe('Express');
      expect(trip.trainType.ar).not.toBe('');
      // Alexandria to Ramsis is positions 1 to 4, so Tanta and Banha.
      expect(trip.intermediateStops).toBe(2);
      expect(trip.durationMinutes).toBe(160);
      expect(trip.availableSeats).toBeGreaterThan(0);
      expect(trip.soldOut).toBe(false);
      // Integer piastres with a currency, excluding the booking fee.
      expect(Number.isInteger(trip.fare.amountMinor)).toBe(true);
      expect(trip.fare.currency).toBe('EGP');
    });

    it('reports Cairo local times with their offset', async () => {
      const { body } = await search();
      const [trip] = (body.data as SearchBody).trips;

      expect(trip.departure.at.localTime).toBe('06:00');
      expect(trip.arrival.at.localTime).toBe('08:40');
      expect(trip.departure.at.timeZone).toBe('Africa/Cairo');
      expect(trip.departure.at.utcOffset).toMatch(/^\+0[23]:00$/);
      expect((body.data as SearchBody).evaluatedAt.timeZone).toBe(
        'Africa/Cairo',
      );
    });

    // Keep selected date-strip dates and trip departures consistent.
    it('departs on the searched date, which the strip also selects', async () => {
      const { body } = await search();
      const data = body.data as SearchBody;

      for (const trip of data.trips) {
        expect(trip.departure.at.localDate).toBe(fixture.searchDate);
      }
      expect(data.dateStrip.find((day) => day.selected)?.date).toBe(
        fixture.searchDate,
      );
    });

    it('offers five bookable days and the window that produced them', async () => {
      const { body } = await search();
      const data = body.data as SearchBody;

      expect(data.dateStrip).toHaveLength(5);
      expect(data.bookingWindow.totalDays).toBe(30);
      expect(data.bookingWindow.firstBookableDate).toBe(fixture.today);
      for (const day of data.dateStrip) {
        expect(day.date >= data.bookingWindow.firstBookableDate).toBe(true);
        expect(day.date <= data.bookingWindow.lastBookableDate).toBe(true);
      }
    });

    // Wire local fields keep Cairo time independent of the client's time zone.
    it('is unaffected by the client sending another timezone', async () => {
      const { body } = await search({}, { acceptLanguage: 'en' });
      const [trip] = (body.data as SearchBody).trips;

      expect(trip.departure.at.localTime).toBe('06:00');
    });
  });

  describe('who may search', () => {
    it('refuses an anonymous request', async () => {
      const response = await fetch(
        `${GATEWAY_URL}${TRIPS}?from=${fixture.stations.alexandria}&to=${fixture.stations.ramsis}&departureDate=${fixture.searchDate}&travelClassId=${fixture.travelClasses.first}`,
      );

      expect(response.status).toBe(401);
    });

    it('refuses a malformed token', async () => {
      const { status } = await search({}, { token: 'not-a-token' });

      expect(status).toBe(401);
    });
  });

  /** Local token verification must work while identity is stopped. */
  describe('when identity is down', () => {
    it('still searches, because the token is verified at the edge', async () => {
      compose('stop', 'identity');

      try {
        const { status, body } = await search();

        expect(status, JSON.stringify(body.error)).toBe(200);
        expect((body.data as SearchBody).trips).toHaveLength(1);
      } finally {
        compose('start', 'identity');
        await waitForServiceReady('identity');
      }
    }, 300_000);
  });

  describe('refusals name the field to change', () => {
    it.each(DETAIL_LANGUAGE_HEADERS)(
      'localizes a same-station DTO refusal for %s, naming To',
      async (acceptLanguage) => {
        const { status, body } = await search(
          { to: fixture.stations.alexandria },
          { acceptLanguage },
        );

        expect(status).toBe(400);
        const english = acceptLanguage?.startsWith('en') === true;
        expect(body.error?.details).toEqual([
          {
            field: 'to',
            rejectedValue: fixture.stations.alexandria,
            issue: english
              ? 'The destination is the same as the origin.'
              : 'محطة الوصول هي نفس محطة المغادرة.',
            action: english
              ? 'Pick a different destination station.'
              : 'اختر محطة وصول مختلفة.',
          },
        ]);
      },
    );

    it.each(DETAIL_LANGUAGE_HEADERS)(
      'localizes an unknown-station catalog refusal for %s',
      async (acceptLanguage) => {
        const stationId = '99999999-9999-4999-8999-999999999999';
        const { status, body } = await search(
          { to: stationId },
          { acceptLanguage },
        );

        expect(status).toBe(400);
        const english = acceptLanguage?.startsWith('en') === true;
        expect(body.error?.details).toEqual([
          {
            field: 'to',
            rejectedValue: stationId,
            issue: english
              ? 'This station is not in the network.'
              : 'هذه المحطة غير موجودة في الشبكة.',
            action: english
              ? 'Pick a station from the station list.'
              : 'اختر محطة من قائمة المحطات.',
          },
        ]);
      },
    );

    it.each(DETAIL_LANGUAGE_HEADERS)(
      'localizes the full booking window for %s without leaking refs or templates',
      async (acceptLanguage) => {
        const available = await search();
        const { firstBookableDate, lastBookableDate } = (
          available.body.data as SearchBody
        ).bookingWindow;
        const { status, body } = await search(
          { departureDate: fixture.pastWindowDate },
          { acceptLanguage },
        );

        expect(status).toBe(400);
        const english = acceptLanguage?.startsWith('en') === true;
        expect(body.error?.details).toEqual([
          {
            field: 'departureDate',
            rejectedValue: fixture.pastWindowDate,
            issue: english
              ? 'This date is beyond the dates currently open for booking.'
              : 'هذا التاريخ خارج الفترة المتاحة للحجز حالياً.',
            action: english
              ? `Pick a date between ${firstBookableDate} and ${lastBookableDate}.`
              : `اختر تاريخاً بين ${firstBookableDate} و${lastBookableDate}.`,
          },
        ]);
        expect(JSON.stringify(body.error?.details)).not.toMatch(
          /ISSUE_|ACTION_|\{\{|undefined/,
        );
      },
    );

    it.each(DETAIL_LANGUAGE_HEADERS)(
      'localizes a malformed-date DTO refusal for %s before reaching catalog',
      async (acceptLanguage) => {
        const { status, body } = await search(
          { departureDate: '20-06-2026' },
          { acceptLanguage },
        );

        expect(status).toBe(400);
        expect(body.error?.details?.[0].issue).toBe(
          acceptLanguage?.startsWith('en') === true
            ? 'This date must be written as YYYY-MM-DD.'
            : 'يجب كتابة هذا التاريخ على صورة YYYY-MM-DD.',
        );
      },
    );

    it('refuses an unknown query parameter', async () => {
      // Unknown parameter names must return 400, not be ignored.
      const { status } = await search({
        departAfterMinutes: '360',
      } as never);

      expect(status).toBe(400);
    });
  });

  describe('an empty result says what to change', () => {
    it('blames the stations for a direction nothing serves', async () => {
      const { status, body } = await search({
        from: fixture.stations.aswan,
        to: fixture.stations.alexandria,
      });

      expect(status).toBe(200);
      const data = body.data as SearchBody;
      expect(data.trips).toEqual([]);
      expect(data.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED',
      );
      expect(data.emptyResult?.message).not.toBe('');
    });

    it('blames the date when the route is served but empty', async () => {
      // A day with no generated trip for this pair.
      const { body } = await search({ departureDate: fixture.today });

      const data = body.data as SearchBody;
      expect(data.trips).toEqual([]);
      expect(data.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE',
      );
    });

    it('answers in Arabic by default and English when asked', async () => {
      const arabic = await search(
        { from: fixture.stations.aswan, to: fixture.stations.alexandria },
        { acceptLanguage: undefined },
      );
      const english = await search(
        { from: fixture.stations.aswan, to: fixture.stations.alexandria },
        { acceptLanguage: 'en-GB,en;q=0.9' },
      );

      const ar = (arabic.body.data as SearchBody).emptyResult?.message ?? '';
      const en = (english.body.data as SearchBody).emptyResult?.message ?? '';

      expect(ar).not.toBe(en);
      // BR-56: Arabic is the fallback, so no header means Arabic.
      expect(/[؀-ۿ]/.test(ar)).toBe(true);

      // Check the exact localized reason; generic fallback text can pass language
      // checks when the enum value or catalog lookup is wrong.
      expect(en).toBe(
        'No train runs between these stations in this direction, please change the stations',
      );
    });

    it('names the date, not the stations, when the date is the problem', async () => {
      const { body } = await search(
        { departureDate: fixture.today },
        { acceptLanguage: 'en' },
      );

      expect((body.data as SearchBody).emptyResult?.message).toBe(
        'Sorry, no trains available on the selected date',
      );
    });
  });

  describe('the optional train number', () => {
    it('narrows the search to that train', async () => {
      const { status, body } = await search({
        trainNumber: String(fixture.trainNumbers.mainLine),
      });

      expect(status).toBe(200);
      expect((body.data as SearchBody).trips).toHaveLength(1);
    });

    it('accepts Arabic-Indic digits', async () => {
      // Use digits from an Arabic keyboard.
      const { status, body } = await search({ trainNumber: '٩٠٣' });

      expect(status, JSON.stringify(body.error)).toBe(200);
      expect((body.data as SearchBody).trips).toHaveLength(1);
    });

    it('refuses an unknown train number', async () => {
      const { status } = await search({ trainNumber: '99999' });

      expect(status).toBe(400);
    });
  });

  /** A Redis outage must preserve search results, even if responses are slower. */
  describe('when Redis is down', () => {
    it('returns the same results', async () => {
      const before = await search();

      compose('stop', 'redis');
      try {
        const during = await search();

        expect(during.status).toBe(200);
        expect((during.body.data as SearchBody).trips).toEqual(
          (before.body.data as SearchBody).trips,
        );
      } finally {
        compose('start', 'redis');
      }
    }, 300_000);
  });

  /** Catalog outages must return retryable errors within the request deadline. */
  describe('when catalog is down', () => {
    it('answers with a retryable error, quickly', async () => {
      compose('stop', 'catalog');

      try {
        const started = Date.now();
        const { status, body } = await search();
        const elapsed = Date.now() - started;

        expect([503, 504]).toContain(status);
        expect(body.error?.retryAfterSeconds).toBeGreaterThan(0);
        // Allow overhead above the 3s gRPC deadline, but reject hangs.
        expect(elapsed).toBeLessThan(15_000);
      } finally {
        compose('start', 'catalog');
        await waitForServiceReady('catalog');
      }
    }, 300_000);

    /**
     * Catalog readiness does not mean the gateway's gRPC channel has reconnected.
     * Backoff can still yield UNAVAILABLE with retryAfterSeconds; poll for
     * bounded recovery rather than requiring the first request to succeed.
     */
    it('recovers once catalog is back', async () => {
      // Poll every five seconds to stay under 60 requests/minute per caller;
      // faster polling can exhaust the budget and return only 429s.
      await waitFor(
        'search to succeed again after catalog restarted',
        async () => (await search()).status === 200,
        60_000,
        5_000,
      );

      const { status, body } = await search();
      expect(status).toBe(200);
      expect((body.data as SearchBody).trips).toHaveLength(1);
    }, 120_000);
  });
});

/**
 * Check authenticated round-trip, filter, stop and recent-search routes,
 * including server-selected return bounds and per-traveller search isolation.
 */
describe('Round trip, filters, stops and recent searches, edge to catalog', () => {
  /**
   * Clear searches recorded by the earlier suite for this same traveller,
   * so cap and ordering checks count only this suite's entries.
   */
  beforeAll(async () => {
    await clearRecentSearches();
  }, 60_000);

  /** The filter pair: two trips, two train types, two fares. */
  const searchFilterPair = (
    query: Parameters<typeof searchTrips>[0] = {},
    options: Parameters<typeof searchTrips>[1] = {},
  ) =>
    searchTrips(
      {
        from: fixture.stations.tanta,
        to: fixture.stations.ramsis,
        departureDate: fixture.searchDate,
        travelClassId: fixture.travelClasses.first,
        ...query,
      },
      { token, ...options },
    );

  const bodyOf = (body: { data?: unknown }) => body.data as SearchBody;

  describe('narrowing and ordering a day', () => {
    it('describes what the day offers before any filter applies', async () => {
      const { status, body } = await searchFilterPair();

      expect(status, JSON.stringify(body.error)).toBe(200);
      const data = bodyOf(body);
      expect(data.trips).toHaveLength(2);
      // Both types appear, so a client can offer the filter at all.
      expect(data.filterOptions.trainTypes).toHaveLength(2);
      expect(data.filterOptions.minFareMinor).toBe(9_000);
      expect(data.filterOptions.maxFareMinor).toBe(25_000);
    });

    it('sorts by fare when asked', async () => {
      const { body } = await searchFilterPair({ sort: 'SEARCH_SORT_FARE_ASC' });

      const fares = bodyOf(body).trips.map((trip) => trip.fare.amountMinor);
      expect(fares).toEqual([9_000, 25_000]);
    });

    it('sorts by departure by default', async () => {
      const { body } = await searchFilterPair();

      const times = bodyOf(body).trips.map(
        (trip) => trip.departure.at.localTime,
      );
      expect(times).toEqual([...times].sort());
    });

    it('keeps only the chosen train type', async () => {
      const { body } = await searchFilterPair({
        trainTypeIds: fixture.trainTypes.sleeper,
      });

      const trips = bodyOf(body).trips;
      expect(trips).toHaveLength(1);
      expect(trips[0].trainNumber).toBe(fixture.trainNumbers.sleeper);
    });

    it('keeps only trips inside the departure window', async () => {
      // The express leaves Tanta at 07:05, the sleeper at 10:00.
      const { body } = await searchFilterPair({
        departAfter: '09:00',
        departBefore: '23:59',
      });

      const trips = bodyOf(body).trips;
      expect(trips).toHaveLength(1);
      expect(trips[0].departure.at.localTime).toBe('10:00');
    });

    it('refuses a window that runs past midnight, naming the field', async () => {
      const { status, body } = await searchFilterPair({
        departAfter: '22:00',
        departBefore: '02:00',
      });

      expect(status).toBe(400);
      expect(body.error?.details?.map((detail) => detail.field)).toContain(
        'departBeforeMinutes',
      );
    });

    it('keeps only trips under a fare ceiling', async () => {
      const { body } = await searchFilterPair({ maxFare: '10000' });

      expect(bodyOf(body).trips.map((trip) => trip.fare.amountMinor)).toEqual([
        9_000,
      ]);
    });

    /** Direct travellers to filters, not another date: trains exist that day. */
    it('blames the filters when they remove everything', async () => {
      const { status, body } = await searchFilterPair(
        { maxFare: '1' },
        { acceptLanguage: 'en' },
      );

      expect(status).toBe(200);
      const data = bodyOf(body);
      expect(data.trips).toEqual([]);
      expect(data.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL',
      );
      expect(data.emptyResult?.message).toContain('filters');
      // Keep unfiltered fares in the facets so clients can suggest a usable ceiling.
      expect(data.filterOptions.minFareMinor).toBe(9_000);
    });

    it('refuses an order it does not offer', async () => {
      const { status } = await searchFilterPair({ sort: 'cheapest' });

      expect(status).toBe(400);
    });
  });

  describe('a round trip, as two calls', () => {
    const outbound = (query: Parameters<typeof searchTrips>[0] = {}) =>
      searchTrips(
        {
          from: fixture.stations.alexandria,
          to: fixture.stations.ramsis,
          departureDate: fixture.searchDate,
          travelClassId: fixture.travelClasses.first,
          returnDate: fixture.returnDate,
          ...query,
        },
        { token },
      );

    const chosenOutboundTripId = async (): Promise<string> => {
      const { body } = await outbound();
      return bodyOf(body).trips[0].tripId;
    };

    it('answers the outbound leg exactly as a one-way search would', async () => {
      const { status, body } = await outbound();

      expect(status, JSON.stringify(body.error)).toBe(200);
      // returnDate selects a round trip; it does not filter the outbound list.
      expect(bodyOf(body).trips).toHaveLength(1);
    });

    it('refuses a return date before the departure date, up front', async () => {
      const { status, body } = await outbound({ returnDate: fixture.today });

      expect(status).toBe(400);
      expect(body.error?.details?.map((detail) => detail.field)).toContain(
        'returnDate',
      );
    });

    it('returns only trips leaving after the outbound arrives', async () => {
      const outboundTripId = await chosenOutboundTripId();

      const { status, body } = await searchReturnTrips(
        {
          outboundTripId,
          outboundFrom: fixture.stations.alexandria,
          outboundTo: fixture.stations.ramsis,
          returnDate: fixture.returnDate,
          travelClassId: fixture.travelClasses.first,
        },
        { token },
      );

      expect(status, JSON.stringify(body.error)).toBe(200);
      const data = bodyOf(body);
      // Two return trips on that date, both after any outbound arrival.
      expect(data.trips).toHaveLength(2);
      expect(data.trips[0].departure.stationId).toBe(fixture.stations.ramsis);
      // Only the first leg includes a date picker.
      expect(data).not.toHaveProperty('dateStrip');
    });

    /** The only same-day return leaves at 06:30, before outbound arrival at 08:40. */
    it('says so when everything left before the outbound arrived', async () => {
      const outboundTripId = await chosenOutboundTripId();

      const { status, body } = await searchReturnTrips(
        {
          outboundTripId,
          outboundFrom: fixture.stations.alexandria,
          outboundTo: fixture.stations.ramsis,
          // Same day as the outbound.
          returnDate: fixture.searchDate,
          travelClassId: fixture.travelClasses.first,
        },
        { token, acceptLanguage: 'en' },
      );

      expect(status).toBe(200);
      const data = bodyOf(body);
      expect(data.trips).toEqual([]);
      expect(data.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL',
      );
      // Report the server-read arrival time and both ways to revise the search.
      expect(data.emptyResult?.message).toContain('08:40');
      expect(data.emptyResult?.message).toContain('return date');
    });

    it.each(DETAIL_LANGUAGE_HEADERS)(
      'localizes a missing-outbound-trip 404 for %s',
      async (acceptLanguage) => {
        const { status, body } = await searchReturnTrips(
          {
            outboundTripId: '00000000-0000-4000-8000-000000000000',
            outboundFrom: fixture.stations.alexandria,
            outboundTo: fixture.stations.ramsis,
            returnDate: fixture.returnDate,
            travelClassId: fixture.travelClasses.first,
          },
          { token, acceptLanguage },
        );

        expect(status).toBe(404);
        expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
        expect(body.error?.message.length).toBeGreaterThan(0);
        expect(body.error?.details).toEqual([
          {
            field: 'outboundTripId',
            rejectedValue: '00000000-0000-4000-8000-000000000000',
            issue:
              acceptLanguage?.startsWith('en') === true
                ? 'This trip is no longer available between those stations.'
                : 'هذه الرحلة لم تعد متاحة بين هاتين المحطتين.',
            action:
              acceptLanguage?.startsWith('en') === true
                ? 'Search again and choose an outbound trip.'
                : 'ابحث مرة أخرى واختر رحلة ذهاب.',
          },
        ]);
        expect(JSON.stringify(body.error?.details)).not.toMatch(
          /issueKey|actionKey|params|\{\{|undefined/,
        );
      },
    );

    it('refuses an anonymous request', async () => {
      const { status } = await searchReturnTrips({
        outboundTripId: '00000000-0000-4000-8000-000000000000',
        outboundFrom: fixture.stations.alexandria,
        outboundTo: fixture.stations.ramsis,
        returnDate: fixture.returnDate,
        travelClassId: fixture.travelClasses.first,
      });

      expect(status).toBe(401);
    });
  });

  describe('the stops of a trip', () => {
    const outboundTrip = async (): Promise<SearchBody['trips'][number]> => {
      const { body } = await searchTrips(
        {
          from: fixture.stations.alexandria,
          to: fixture.stations.aswan,
          departureDate: fixture.searchDate,
          travelClassId: fixture.travelClasses.first,
        },
        { token },
      );
      return bodyOf(body).trips[0];
    };

    interface StopsBody {
      stops: {
        stationId: string;
        name: { en: string; ar: string };
        departure?: { localTime: string; timeZone: string };
        arrival?: { localTime: string };
        boarding: boolean;
        alighting: boolean;
      }[];
    }

    it('lists the segment in travel order, with Cairo times', async () => {
      const trip = await outboundTrip();

      const { status, body } = await tripStops(
        trip.tripId,
        { from: fixture.stations.alexandria, to: fixture.stations.aswan },
        { token },
      );

      expect(status, JSON.stringify(body.error)).toBe(200);
      const { stops } = body.data as StopsBody;

      expect(stops[0].boarding).toBe(true);
      expect(stops[stops.length - 1].alighting).toBe(true);
      expect(stops[0].departure?.localTime).toBe('06:00');
      expect(stops[0].departure?.timeZone).toBe('Africa/Cairo');
      // Nothing arrives at the trip's first stop.
      expect(stops[0].arrival).toBeUndefined();
      // Catalog supplies both name languages.
      expect(stops[0].name.ar.length).toBeGreaterThan(0);
    });

    /** Stops must match the intermediate-stop count returned by search. */
    it('has as many stops between as the search result claimed', async () => {
      const trip = await outboundTrip();

      const { body } = await tripStops(
        trip.tripId,
        { from: fixture.stations.alexandria, to: fixture.stations.aswan },
        { token },
      );
      const { stops } = body.data as StopsBody;

      expect(stops.length - 2).toBe(trip.intermediateStops);
    });

    it('refuses a pair the trip does not serve in that order', async () => {
      const trip = await outboundTrip();

      const { status } = await tripStops(
        trip.tripId,
        { from: fixture.stations.aswan, to: fixture.stations.alexandria },
        { token },
      );

      expect(status).toBe(404);
    });

    it('refuses an anonymous request', async () => {
      const { status } = await tripStops(
        '00000000-0000-4000-8000-000000000000',
        { from: fixture.stations.alexandria, to: fixture.stations.ramsis },
      );

      expect(status).toBe(401);
    });
  });

  describe('recent searches', () => {
    interface RecentBody {
      recentSearches: {
        origin: { id: string; name: { en: string; ar: string } };
        destination: { id: string };
        kind: string;
        trainNumber?: number;
        departureDate?: string;
        returnDate?: string;
      }[];
    }

    const listFor = async (bearer: string): Promise<RecentBody> => {
      const { body } = await recentSearches({ token: bearer });
      return body.data as RecentBody;
    };

    const runSearch = (
      query: Parameters<typeof searchTrips>[0],
      bearer = token,
    ) =>
      searchTrips(
        {
          departureDate: fixture.searchDate,
          travelClassId: fixture.travelClasses.first,
          ...query,
        },
        { token: bearer },
      );

    it('remembers a search the traveller just ran', async () => {
      await runSearch({
        from: fixture.stations.alexandria,
        to: fixture.stations.ramsis,
      });

      const { recentSearches: entries } = await listFor(token);

      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].origin.id).toBe(fixture.stations.alexandria);
      // Return both languages so the client can choose (BR-56).
      expect(entries[0].origin.name.en.length).toBeGreaterThan(0);
      expect(entries[0].origin.name.ar.length).toBeGreaterThan(0);
    });

    it('records a round-trip search as one entry carrying both dates', async () => {
      await runSearch({
        from: fixture.stations.tanta,
        to: fixture.stations.giza,
        returnDate: fixture.returnDate,
      });

      const { recentSearches: entries } = await listFor(token);
      const roundTrip = entries.find(
        (entry) => entry.destination.id === fixture.stations.giza,
      );

      expect(roundTrip?.kind).toBe('RECENT_SEARCH_KIND_ROUND_TRIP');
      expect(roundTrip?.departureDate).toBe(fixture.searchDate);
      expect(roundTrip?.returnDate).toBe(fixture.returnDate);
    });

    it('moves a repeated search to the top instead of duplicating it', async () => {
      const repeat = () =>
        runSearch({
          from: fixture.stations.banha,
          to: fixture.stations.giza,
        });

      await repeat();
      const before = await listFor(token);
      await repeat();
      const after = await listFor(token);

      const occurrences = (list: RecentBody) =>
        list.recentSearches.filter(
          (entry) =>
            entry.origin.id === fixture.stations.banha &&
            entry.destination.id === fixture.stations.giza,
        ).length;

      expect(occurrences(before)).toBe(1);
      expect(occurrences(after)).toBe(1);
      expect(after.recentSearches[0].origin.id).toBe(fixture.stations.banha);
    });

    it('keeps at most five, newest first', async () => {
      const cappedToken = await travellerAccessToken();
      // Quotas are IP-scoped, even for a new account. Expire the prior windows.
      await new Promise<void>((resolve) => setTimeout(resolve, 61_000));
      // Six distinct destinations from one origin, in order, so the newest is
      // known. More than five on purpose: the cap is the assertion.
      for (const to of [
        fixture.stations.tanta,
        fixture.stations.banha,
        fixture.stations.ramsis,
        fixture.stations.giza,
        fixture.stations.assiut,
        fixture.stations.aswan,
      ]) {
        const { status, body } = await runSearch(
          { from: fixture.stations.alexandria, to },
          cappedToken,
        );
        expect(status, JSON.stringify(body.error)).toBe(200);
        await waitFor(
          `recent Alexandria-to-${to} search to be persisted`,
          async () => {
            const { recentSearches: entries } = await listFor(cappedToken);
            return (
              entries[0]?.origin.id === fixture.stations.alexandria &&
              entries[0]?.destination.id === to
            );
          },
          10_000,
          2_500,
        );
      }

      const { recentSearches: entries } = await listFor(cappedToken);

      expect(entries).toHaveLength(5);
      expect(entries[0].destination.id).toBe(fixture.stations.aswan);
      expect(
        entries.some(
          (entry) => entry.destination.id === fixture.stations.tanta,
        ),
      ).toBe(false);
    }, 300_000);

    /** §2.3 rule 6: never visible to another account. */
    it('is invisible to a different traveller', async () => {
      const mine = await listFor(token);
      const theirs = await listFor(otherToken);

      expect(mine.recentSearches.length).toBeGreaterThan(0);
      expect(theirs.recentSearches).toEqual([]);
    });

    it('refuses an anonymous request', async () => {
      const { status } = await recentSearches();

      expect(status).toBe(401);
    });
  });
});
