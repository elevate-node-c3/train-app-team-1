import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ACCESS_LEVEL_KEY } from '@app/common';
import {
  AllocationOutcome,
  ErrorCode,
  type BookingResponse,
} from '@app/contracts';

import { BookingController } from './booking.controller.js';
import { BookingRequestGuard } from './booking-request.guard.js';
import type { BookingService } from './booking.service.js';
import { NoSeatSelectionPipe } from './dto/create-booking.dto.js';

const TRIP_ID = '11111111-1111-4111-8111-111111111111';
const RETURN_TRIP_ID = '55555555-5555-4555-8555-555555555555';
const CLASS_ID = '22222222-2222-4222-8222-222222222222';
const ORIGIN_ID = '33333333-3333-4333-8333-333333333333';
const DESTINATION_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PASSENGER_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PASSENGER_TWO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

/** A booking as checkout answers; the gateway only passes it on. */
function bookingResponse(legs: BookingResponse['legs'] = []): BookingResponse {
  return {
    bookingReference: '70000000-0000-4000-8000-000000000001',
    state: 'seats_held',
    totalPiastres: 12_500,
    currency: 'EGP',
    holdExpiresAt: new Date().toISOString(),
    paymentReference: '',
    serverTime: new Date().toISOString(),
    legs,
    fareTotalPiastres: 12_000,
    bookingFeePiastres: 500,
    bookingFeePercent: 4,
    termsAcceptedAt: '',
  };
}

function leg(
  tripId: string,
  outcome: AllocationOutcome,
  splitNotice?: BookingResponse['legs'][number]['splitNotice'],
): BookingResponse['legs'][number] {
  return {
    tripId,
    trainNumber: 101,
    trainType: { ar: 'مكيف', en: 'Air-conditioned' },
    departure: {
      stationId: ORIGIN_ID,
      name: { ar: '', en: '' },
      at: new Date().toISOString(),
    },
    arrival: {
      stationId: DESTINATION_ID,
      name: { ar: '', en: '' },
      at: new Date().toISOString(),
    },
    farePiastres: 6_000,
    allocationOutcome: outcome,
    ...(splitNotice ? { splitNotice } : {}),
    passengers: [],
  } as unknown as BookingResponse['legs'][number];
}

/** Guards read the raw request, before any pipe has touched it. */
function guardContextFor(
  body: unknown,
  headers: Record<string, unknown> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ body, headers }) }),
  } as unknown as ExecutionContext;
}

describe('BookingController & route validation', () => {
  let controller: BookingController;
  let bookings: {
    submit: ReturnType<typeof vi.fn>;
    review: ReturnType<typeof vi.fn>;
    acceptTerms: ReturnType<typeof vi.fn>;
    continueToPayment: ReturnType<typeof vi.fn>;
    abandon: ReturnType<typeof vi.fn>;
  };
  let pipe: NoSeatSelectionPipe;
  let guard: BookingRequestGuard;

  beforeEach(() => {
    bookings = {
      submit: vi.fn().mockResolvedValue(bookingResponse()),
      review: vi.fn().mockResolvedValue(bookingResponse()),
      acceptTerms: vi.fn().mockResolvedValue(bookingResponse()),
      continueToPayment: vi.fn().mockResolvedValue(bookingResponse()),
      abandon: vi.fn().mockResolvedValue(bookingResponse()),
    };
    controller = new BookingController(bookings as unknown as BookingService);
    pipe = new NoSeatSelectionPipe();
    guard = new BookingRequestGuard();
  });

  describe('route security and metadata (BR-01, R4)', () => {
    it('requires a bookable profile at the booking entry', () => {
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, BookingController)).toBe(
        'bookable',
      );
    });
  });

  describe('the server allocates: no seat or coach may be chosen (BR-25, D2)', () => {
    const forbiddenPayloads = [
      {
        name: 'seatId at root',
        body: { tripId: TRIP_ID, seatId: 'seat-uuid-12' },
        expectedKey: 'seatId',
      },
      {
        name: 'coachNumber at root',
        body: { tripId: TRIP_ID, coachNumber: 3 },
        expectedKey: 'coachNumber',
      },
      {
        name: 'seat_number in snake case',
        body: { tripId: TRIP_ID, seat_number: '12A' },
        expectedKey: 'seat_number',
      },
      {
        name: 'a seat nested inside a leg',
        body: { legs: [{ tripId: TRIP_ID, seatNumber: '12A' }] },
        expectedKey: 'seatNumber',
      },
      {
        name: 'a seats array',
        body: { tripId: TRIP_ID, seats: ['12A', '12B'] },
        expectedKey: 'seats',
      },
    ];

    it.each(forbiddenPayloads)(
      'the pipe refuses $name as INVALID_PAYLOAD',
      ({ body, expectedKey }) => {
        try {
          pipe.transform(body, { type: 'body' } as never);
          expect.unreachable('the payload should have been refused');
        } catch (error) {
          const refusal = error as HttpException;
          expect(refusal.getStatus()).toBe(HttpStatus.BAD_REQUEST);
          const response = refusal.getResponse() as Record<string, unknown>;
          expect(response.code).toBe(ErrorCode.INVALID_PAYLOAD);
          expect(String(response.message)).toContain(expectedKey);
        }
      },
    );

    it.each(forbiddenPayloads)(
      'the guard refuses $name before any pipe runs',
      ({ body }) => {
        // The guard's allow-list is the first of the two: a key it does not
        // know never reaches the pipe, the DTO or booking.
        expect(() => guard.canActivate(guardContextFor(body))).toThrow(
          HttpException,
        );
      },
    );
  });

  describe('what the guard refuses, so nothing downstream has to', () => {
    it('never honours an owner supplied in the body', () => {
      expect(() =>
        guard.canActivate(
          guardContextFor({
            bookingKey: BOOKING_KEY,
            passengerIds: [PASSENGER_ONE],
            userId: 'attacker',
          }),
        ),
      ).toThrow(HttpException);
    });

    it('requires saved passenger references, not a passenger count', () => {
      expect(() =>
        guard.canActivate(
          guardContextFor({ bookingKey: BOOKING_KEY, groupSize: 2 }),
        ),
      ).toThrow(HttpException);
    });

    it('refuses a body key that disagrees with the Idempotency-Key header', () => {
      expect(() =>
        guard.canActivate(
          guardContextFor(
            { bookingKey: BOOKING_KEY, passengerIds: [PASSENGER_ONE] },
            { 'idempotency-key': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          ),
        ),
      ).toThrow(HttpException);
    });

    it('accepts a well-formed submission', () => {
      expect(
        guard.canActivate(
          guardContextFor(
            {
              passengerIds: [PASSENGER_ONE, PASSENGER_TWO],
              tripId: TRIP_ID,
              travelClassId: CLASS_ID,
              originStationId: ORIGIN_ID,
              destinationStationId: DESTINATION_ID,
            },
            { 'idempotency-key': BOOKING_KEY },
          ),
        ),
      ).toBe(true);
    });
  });

  describe('what reaches checkout', () => {
    it('sends one leg, the class, and the header key as the idempotency key', async () => {
      await controller.submit(
        {
          passengerIds: [PASSENGER_ONE, PASSENGER_TWO],
          tripId: TRIP_ID,
          travelClassId: CLASS_ID,
          originStationId: ORIGIN_ID,
          destinationStationId: DESTINATION_ID,
        } as never,
        BOOKING_KEY,
      );

      // No owner: booking reads the caller from the call's metadata.
      expect(bookings.submit).toHaveBeenCalledWith(
        {
          passengerIds: [PASSENGER_ONE, PASSENGER_TWO],
          tripId: TRIP_ID,
          travelClassId: CLASS_ID,
          originStationId: ORIGIN_ID,
          destinationStationId: DESTINATION_ID,
        },
        BOOKING_KEY,
      );
    });

    it('returns a round trip with its per-leg outcome and split notice', async () => {
      const splitNotice = {
        code: 'SEATS_SPLIT',
        message: 'لم نتمكن من جلوسكم معاً.',
        messageEn: 'Seats have been split across coaches',
      };
      bookings.submit.mockResolvedValueOnce(
        bookingResponse([
          leg(TRIP_ID, AllocationOutcome.SIDE_BY_SIDE),
          leg(RETURN_TRIP_ID, AllocationOutcome.SPLIT, splitNotice),
        ]),
      );

      const result = await controller.submit(
        {
          passengerIds: [PASSENGER_ONE, PASSENGER_TWO],
          legs: [
            {
              tripId: TRIP_ID,
              travelClassId: CLASS_ID,
              originStationId: ORIGIN_ID,
              destinationStationId: DESTINATION_ID,
            },
            {
              tripId: RETURN_TRIP_ID,
              travelClassId: CLASS_ID,
              originStationId: DESTINATION_ID,
              destinationStationId: ORIGIN_ID,
            },
          ],
        } as never,
        BOOKING_KEY,
      );

      expect(result.legs[0].allocationOutcome).toBe(
        AllocationOutcome.SIDE_BY_SIDE,
      );
      expect(result.legs[0].splitNotice).toBeUndefined();
      expect(result.legs[1].allocationOutcome).toBe(AllocationOutcome.SPLIT);
      expect(result.legs[1].splitNotice?.messageEn).toContain(
        'Seats have been split across coaches',
      );
    });

    it('passes a refusal through unchanged', async () => {
      bookings.submit.mockRejectedValueOnce(
        new HttpException(
          { code: ErrorCode.INSUFFICIENT_SEATS },
          HttpStatus.CONFLICT,
        ),
      );

      const error = await controller
        .submit({ passengerIds: [PASSENGER_ONE] } as never, BOOKING_KEY)
        .catch((caught: unknown) => caught);

      expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
      expect(
        (error as HttpException).getResponse() as Record<string, unknown>,
      ).toMatchObject({ code: ErrorCode.INSUFFICIENT_SEATS });
    });
  });

  describe('the steps after the seats are held', () => {
    const reference = '70000000-0000-4000-8000-000000000001';

    it.each([
      ['review', 'review'],
      ['acceptTerms', 'acceptTerms'],
      ['continueToPayment', 'continueToPayment'],
      ['abandon', 'abandon'],
    ] as const)(
      '%s names the booking and nothing else',
      async (route, call) => {
        await controller[route]({ bookingReference: reference });

        if (route === 'continueToPayment') {
          expect(bookings[call]).toHaveBeenCalledWith({
            bookingReference: reference,
            savedCardId: undefined,
          });
        } else {
          expect(bookings[call]).toHaveBeenCalledWith(reference);
        }
      },
    );

    it('passes the selected local saved-card reference to payment', async () => {
      const savedCardId = '70000000-0000-4000-8000-000000000002';

      await controller.continueToPayment(
        { bookingReference: reference },
        { savedCardId },
      );

      expect(bookings.continueToPayment).toHaveBeenCalledWith({
        bookingReference: reference,
        savedCardId,
      });
    });
  });
});
