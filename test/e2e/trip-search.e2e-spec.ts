import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EMAIL_QUEUE,
  GATEWAY_URL,
  compose,
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
 * One-way search, through the whole stack.
 *
 * What this tier is for is the things no other tier can reach: that the route
 * is authenticated, that a stopped catalog produces a retryable error instead
 * of a hang, that a stopped Redis changes nothing a traveller sees, and that
 * identity being down does not stop a search.
 *
 * What it deliberately does NOT cover is the clock-dependent rules -- the
 * 15-minute sales-close boundary, the Cairo-date-at-origin rule for an
 * overnight trip, the fare in force. Those need a controlled `now`, which a
 * real HTTP request through a real gateway cannot have, and they are proven at
 * the integration tier against real Postgres with a frozen clock. Repeating
 * them here with the wall clock would be a weaker test wearing a stronger
 * test's clothes.
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
  /** TA-18: what the day offers, before the request's own filters. */
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
 * The stack is started once for the whole file, not once per suite.
 *
 * It has to be at this level: a suite's `afterAll` runs before the next
 * suite's `beforeAll`, so a `stopStack()` inside the first describe would tear
 * the containers down -- and `startSearchStack` begins with `compose down -v`,
 * so the second suite would have had to rebuild everything to get them back.
 * One build, two suites, six minutes instead of twelve.
 */
let fixture: E2eSearchFixture;
/** The traveller the suites search as. */
let token: string;
/** A second one, for the "never visible to another account" rule. */
let otherToken: string;

beforeAll(async () => {
  startSearchStack();
  await waitForGateway();
  await waitForServiceReady('identity');
  await waitForServiceReady('catalog');

  // The verification code travels identity -> rabbitmq -> notification ->
  // mailpit, so the token cannot be obtained until that consumer is bound.
  await waitForServiceReady('notification');
  await waitForConsumer(EMAIL_QUEUE);

  // Seeded from the host through the published port, after catalog has
  // migrated: the tables only exist once it has booted.
  fixture = await seedSearchE2e();
  token = await travellerAccessToken();
  otherToken = await travellerAccessToken();
}, 1_800_000);

afterAll(() => {
  stopStack();
}, 300_000);

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

    // Every result departs on the date that was searched -- the inconsistency
    // in the design's sample data must not be reproducible.
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

    // A client on another device clock must still read Cairo time, which is
    // the whole reason the wire carries local fields rather than an instant.
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

  /**
   * The headline claim: the token is verified locally, so identity can be
   * stopped and a traveller can still search. Asserted with identity actually
   * down, which is the only way to know.
   */
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
      // A typo in a parameter name is a 400, not a silently ignored filter.
      // (`returnDate` used to be the example here; TA-18 made it real.)
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

      // The exact sentence, not just "non-empty in the right script". The
      // generic fallback is also non-empty and also differs by language, so a
      // weaker assertion passed while the reason was arriving as a number and
      // the catalogue lookup was missing entirely.
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
      // ٩٠٣, as an Arabic keyboard produces it.
      const { status, body } = await search({ trainNumber: '٩٠٣' });

      expect(status, JSON.stringify(body.error)).toBe(200);
      expect((body.data as SearchBody).trips).toHaveLength(1);
    });

    it('refuses an unknown train number', async () => {
      const { status } = await search({ trainNumber: '99999' });

      expect(status).toBe(400);
    });
  });

  /**
   * A cache outage must not become a search outage: the same request has to
   * return the same answer, just slower.
   */
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

  /**
   * A stopped catalog must produce a retryable error inside the deadline, not
   * a request that never returns. The timing assertion is the point: a hang
   * would otherwise look like a slow pass.
   */
  describe('when catalog is down', () => {
    it('answers with a retryable error, quickly', async () => {
      compose('stop', 'catalog');

      try {
        const started = Date.now();
        const { status, body } = await search();
        const elapsed = Date.now() - started;

        expect([503, 504]).toContain(status);
        expect(body.error?.retryAfterSeconds).toBeGreaterThan(0);
        // Comfortably above the 3s deadline, far below a hang.
        expect(elapsed).toBeLessThan(15_000);
      } finally {
        compose('start', 'catalog');
        await waitForServiceReady('catalog');
      }
    }, 300_000);

    /**
     * Recovery is polled, not asserted on the first request.
     *
     * `waitForServiceReady` says catalog is answering again, but the gateway's
     * gRPC channel reconnects on its own backoff, so the first request after a
     * restart can still be UNAVAILABLE. That is the correct behaviour -- the
     * 503 carries `retryAfterSeconds` precisely so a client retries -- and
     * demanding instant recovery would assert a timing detail of the channel
     * rather than anything about search. What matters is that it recovers, and
     * within a bound.
     */
    it('recovers once catalog is back', async () => {
      // Polled every five seconds, not twice a second: the route allows 60
      // requests a minute per caller, and a tight loop would spend that budget
      // on 429s and then never observe the 200 it is waiting for.
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
 * TA-18, through the whole stack.
 *
 * Same division of labour as the suite above: the rules that need a controlled
 * clock are proven at the integration tier, and what is checked here is what
 * only a real request can show -- that the three new routes exist and are
 * authenticated, that the round trip works as two calls with the server
 * deciding the bound, and that one traveller's recent searches are invisible
 * to another.
 */
describe('Round trip, filters, stops and recent searches, edge to catalog', () => {
  /**
   * Recent searches are a count, so this suite starts from a clean table.
   *
   * The suite above searches as the same traveller, and its searches are
   * recorded too -- which is correct behaviour and would quietly make "at most
   * five, newest first" assert against rows this suite did not create.
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

    /**
     * The empty result has to send the traveller to the filters, not the date
     * picker: there ARE trains that day.
     */
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
      // The facets still describe the unfiltered day, so a client can show
      // what the ceiling would have to be.
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
      // The return date is an intent, not a filter on this list.
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
      // The reverse direction: back to where the traveller started.
      expect(data.trips[0].departure.stationId).toBe(fixture.stations.ramsis);
      // No picker on the second leg -- the first call already sent it.
      expect(data).not.toHaveProperty('dateStrip');
    });

    /**
     * The story's own edge case, reached honestly: the only return trip on the
     * outbound date leaves at 06:30, and the outbound reaches Ramsis at 08:40.
     */
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
      // Both ways out, and the arrival the server read for itself.
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
      // Names come from the catalogue, in both languages.
      expect(stops[0].name.ar.length).toBeGreaterThan(0);
    });

    /** The rule the design's chip depends on: the counts have to agree. */
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
      // Both languages travel, so the client picks (BR-56).
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
        const { status, body } = await runSearch({
          from: fixture.stations.alexandria,
          to,
        });
        expect(status, JSON.stringify(body.error)).toBe(200);
        await waitFor(
          `recent Alexandria-to-${to} search to be persisted`,
          async () => {
            const { recentSearches: entries } = await listFor(token);
            return (
              entries[0]?.origin.id === fixture.stations.alexandria &&
              entries[0]?.destination.id === to
            );
          },
          10_000,
          100,
        );
      }

      const { recentSearches: entries } = await listFor(token);

      expect(entries).toHaveLength(5);
      expect(entries[0].destination.id).toBe(fixture.stations.aswan);
      // The oldest of the six is gone.
      expect(
        entries.some(
          (entry) => entry.destination.id === fixture.stations.tanta,
        ),
      ).toBe(false);
    });

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
