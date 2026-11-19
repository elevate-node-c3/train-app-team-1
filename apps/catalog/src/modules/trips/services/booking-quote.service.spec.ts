import { describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { ErrorCode } from '@app/contracts';
import { BookingQuoteService } from './booking-quote.service.js';
import { CatalogSearchError } from '../catalog-search-error.js';

function row(amount: number, departure: Date, arrival: Date) {
  return {
    amount_piastres: amount,
    train_number: 905,
    train_type_en: 'Spanish',
    train_type_ar: 'إسباني',
    class_en: 'First',
    class_ar: 'الأولى',
    origin_en: 'Cairo',
    origin_ar: 'القاهرة',
    destination_en: 'Alexandria',
    destination_ar: 'الإسكندرية',
    departure_at: departure,
    arrival_at: arrival,
  };
}

const legs = [
  {
    tripId: 'trip-one',
    originStationId: 'origin-one',
    destinationStationId: 'destination-one',
  },
  {
    tripId: 'trip-two',
    originStationId: 'origin-two',
    destinationStationId: 'destination-two',
  },
];

describe('BookingQuoteService', () => {
  it('prices each leg for one passenger and leaves the totals to booking', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const later = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const dataSource = {
      query: vi
        .fn()
        .mockResolvedValueOnce([row(4_000, soon, later)])
        .mockResolvedValueOnce([row(6_000, later, later)]),
    } as unknown as DataSource;
    const service = new BookingQuoteService(dataSource);

    const result = await service.quote({ legs, travelClassId: 'class-id' });

    expect(result.travelClass).toEqual({
      id: 'class-id',
      name: { en: 'First', ar: 'الأولى' },
    });
    expect(result.legs.map((leg) => leg.fare)).toEqual([
      { amountMinor: 4_000, currency: 'EGP' },
      { amountMinor: 6_000, currency: 'EGP' },
    ]);
    expect(result.legs[0]).toMatchObject({
      tripId: 'trip-one',
      trainNumber: 905,
      trainType: { en: 'Spanish', ar: 'إسباني' },
      departure: {
        stationId: 'origin-one',
        name: { en: 'Cairo', ar: 'القاهرة' },
      },
      arrival: { stationId: 'destination-one' },
    });
    expect(result.legs[0].departure.at.timeZone).toBe('Africa/Cairo');
    expect(dataSource.query).toHaveBeenCalledTimes(2);
  });

  it('refuses a leg with no current fare as sales closed, naming the leg', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const dataSource = {
      query: vi
        .fn()
        .mockResolvedValueOnce([row(4_000, soon, soon)])
        .mockResolvedValueOnce([]),
    } as unknown as DataSource;
    const service = new BookingQuoteService(dataSource);

    const error = await service
      .quote({ legs, travelClassId: 'class-id' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CatalogSearchError);
    expect(error).toMatchObject({
      code: ErrorCode.SALES_CLOSED,
      details: [{ field: 'legs[1].tripId', rejectedValue: 'trip-two' }],
    });
  });
});
