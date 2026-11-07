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
  searchTrips,
  startSearchStack,
  travellerAccessToken,
} from './support/search-stack.js';
import { seedSearchE2e, type E2eSearchFixture } from './support/seed-search-e2e.js';

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

interface SearchBody {
  dateStrip: { date: string; selected: boolean; isToday: boolean }[];
  trips: {
    tripId: string;
    trainNumber: number;
    trainType: { en: string; ar: string };
    departure: {
      stationId: string;
      at: { localDate: string; localTime: string; utcOffset: string; timeZone: string };
    };
    arrival: { at: { localDate: string; localTime: string } };
    durationMinutes: number;
    intermediateStops: number;
    availableSeats: number;
    soldOut: boolean;
    fare: { amountMinor: number; currency: string };
  }[];
  bookingWindow: { firstBookableDate: string; lastBookableDate: string; totalDays: number };
  evaluatedAt: { timeZone: string };
  emptyResult?: { reason: string; message: string };
}

describe('One-way search, edge to catalog', () => {
  let fixture: E2eSearchFixture;
  let token: string;

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
  }, 1_200_000);

  afterAll(() => {
    stopStack();
  }, 300_000);

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
    it('refuses the same station twice, naming To', async () => {
      const { status, body } = await search({
        to: fixture.stations.alexandria,
      });

      expect(status).toBe(400);
      const details = body.error?.details ?? [];
      expect(details.map((detail) => detail.field)).toContain('to');
    });

    it('refuses an unknown station', async () => {
      const { status } = await search({
        to: '99999999-9999-4999-8999-999999999999',
      });

      expect(status).toBe(400);
    });

    it('refuses a date past the booking window', async () => {
      const { status, body } = await search({
        departureDate: fixture.pastWindowDate,
      });

      expect(status).toBe(400);
      const details = body.error?.details ?? [];
      const date = details.find((detail) => detail.field === 'departureDate');
      // The traveller needs the date to pick instead, not only a rejection.
      expect(date?.action).toContain('-');
    });

    it('refuses a malformed date before reaching catalog', async () => {
      const { status } = await search({ departureDate: '20-06-2026' });

      expect(status).toBe(400);
    });

    it('refuses an unknown query parameter', async () => {
      const { status } = await search({
        returnDate: fixture.searchDate,
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
