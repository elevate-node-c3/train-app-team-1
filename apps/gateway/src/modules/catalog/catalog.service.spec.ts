import type { SearchOneWayTripsResponse } from '@app/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CatalogGrpcClientService } from './catalog.grpc.client.js';
import { CatalogService } from './catalog.service.js';
import type { SearchTripsDto } from './dto/search-trips.dto.js';

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
  });

  describe('the response it returns', () => {
    it('passes the strip, window and trips through untouched', async () => {
      const { service } = serviceWith(baseResponse);

      const result = await service.searchOneWay(query(), 'en');

      expect(result.dateStrip).toEqual(baseResponse.dateStrip);
      expect(result.bookingWindow).toEqual(baseResponse.bookingWindow);
      expect(result.evaluatedAt).toEqual(baseResponse.evaluatedAt);
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
    const withReason = (
      reason: string,
      params: Record<string, string> = {},
    ) =>
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
