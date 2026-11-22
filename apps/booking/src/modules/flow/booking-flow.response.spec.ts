import { describe, expect, it } from 'vitest';
import type { SettledSeat } from '../draft/entities/booking-draft.entity.js';
import { BookingDraftEntity } from '../draft/entities/booking-draft.entity.js';
import { TicketEntity } from './entities/ticket.entity.js';
import { toBookingResponse } from './booking-flow.response.js';
import { AllocationOutcome, SEATS_SPLIT_NOTICE } from '@app/contracts';

const TRIP = 'trip-1';
const PASSENGER = 'p1';

function draft(
  overrides: Partial<BookingDraftEntity> = {},
): BookingDraftEntity {
  return Object.assign(new BookingDraftEntity(), {
    id: 'booking-1',
    flowState: 'confirming',
    totalPiastres: 6955,
    fareTotalPiastres: 6500,
    bookingFeePiastres: 455,
    expiresAt: null,
    paymentReference: null,
    travelClass: undefined,
    legs: [],
    quotedLegs: [
      {
        tripId: TRIP,
        trainNumber: 123,
        trainType: { en: 'Express', ar: 'سريع' },
        departure: {
          stationId: 'station-a',
          name: { en: 'A', ar: 'أ' },
          at: {
            localDate: '2026-11-22',
            localTime: '10:00',
            utcOffset: '+02:00',
            iso: '2026-11-22T10:00:00+02:00',
            timeZone: 'Africa/Cairo',
          },
        },
        arrival: {
          stationId: 'station-b',
          name: { en: 'B', ar: 'ب' },
          at: {
            localDate: '2026-11-22',
            localTime: '13:00',
            utcOffset: '+02:00',
            iso: '2026-11-22T13:00:00+02:00',
            timeZone: 'Africa/Cairo',
          },
        },
        fare: { amountMinor: 6500, currency: 'EGP' },
      },
    ],
    passengerSnapshot: [
      {
        passengerRef: PASSENGER,
        displayName: 'Passenger One',
        maskedNationalId: '***',
        identities: [],
      },
    ],
    holdSnapshot: null,
    settledSeats: null,
    seatsChanged: false,
    termsAcceptedAt: null,
    ...overrides,
  });
}

function ticket(overrides: Partial<TicketEntity> = {}): TicketEntity {
  return Object.assign(new TicketEntity(), {
    id: 'ticket-1',
    bookingReference: 'booking-1',
    passengerRef: PASSENGER,
    tripId: TRIP,
    ticketNumber: 'TKT-1',
    coachNumber: 1,
    seatNumber: '1A',
    ...overrides,
  });
}

function seat(overrides: Partial<SettledSeat> = {}): SettledSeat {
  return {
    passengerRef: PASSENGER,
    tripId: TRIP,
    coachNumber: 1,
    seatNumber: '1A',
    ...overrides,
  };
}

describe('toBookingResponse', () => {
  it('reports confirming, not confirmed, while the saga is still running', () => {
    const response = toBookingResponse(draft({ flowState: 'confirming' }), []);
    expect(response.state).toBe('confirming');
    expect(response.tickets).toEqual([]);
  });

  it('returns the tickets once the booking is confirmed', () => {
    const response = toBookingResponse(draft({ flowState: 'confirmed' }), [
      ticket({ ticketNumber: 'TKT-1' }),
    ]);
    expect(response.state).toBe('confirmed');
    expect(response.tickets[0].ticketNumber).toBe('TKT-1');
  });

  it('shows the new seats and the flag when a late payment moved them', () => {
    const response = toBookingResponse(
      draft({
        flowState: 'confirmed',
        seatsChanged: true,
        settledSeats: [seat({ coachNumber: 7, seatNumber: '12' })],
      }),
      [ticket({ coachNumber: 7, seatNumber: '12' })],
    );
    expect(response.seatsChanged).toBe(true);
    expect(response.legs[0].passengers[0].seatNumber).toBe('12');
  });

  it('exposes the SDK secret only while the owner can still pay', () => {
    const paymentClientSecret = 'pi_booking_secret_private';
    expect(
      toBookingResponse(
        draft({
          flowState: 'awaiting_payment',
          paymentClientSecret,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).clientSecret,
    ).toBe(paymentClientSecret);
    for (const flowState of [
      'confirming',
      'confirmed',
      'refunding',
      'refunded',
      'expired',
      'abandoned',
    ] as const) {
      expect(
        toBookingResponse(draft({ flowState, paymentClientSecret }))
          .clientSecret,
      ).toBe('');
    }
  });

  it('withholds the SDK secret at and after the actual hold deadline', () => {
    const expiresAt = new Date('2026-11-22T01:00:00.000Z');
    const booking = draft({
      flowState: 'awaiting_payment',
      expiresAt,
      paymentClientSecret: 'pi_booking_secret_private',
    });
    expect(
      toBookingResponse(booking, [], new Date(expiresAt.getTime() - 1))
        .clientSecret,
    ).toBe('pi_booking_secret_private');
    expect(toBookingResponse(booking, [], expiresAt).clientSecret).toBe('');
    expect(
      toBookingResponse(booking, [], new Date(expiresAt.getTime() + 1))
        .clientSecret,
    ).toBe('');
  });

  it('uses the settled allocation and not an obsolete split warning', () => {
    const legs = [{ tripId: TRIP, splitNotice: SEATS_SPLIT_NOTICE }];
    const response = toBookingResponse(
      draft({
        seatsChanged: true,
        legs: legs as BookingDraftEntity['legs'],
        settledSeats: [seat({ outcome: AllocationOutcome.SIDE_BY_SIDE })],
      }),
    );
    expect(response.legs[0].allocationOutcome).toBe(
      AllocationOutcome.SIDE_BY_SIDE,
    );
    expect(response.legs[0].splitNotice).toBeUndefined();
  });

  it('reports a new split allocation from settlement metadata', () => {
    const response = toBookingResponse(
      draft({
        seatsChanged: true,
        settledSeats: [seat({ outcome: AllocationOutcome.SPLIT })],
      }),
    );
    expect(response.legs[0].allocationOutcome).toBe(AllocationOutcome.SPLIT);
    expect(response.legs[0].splitNotice).toEqual(SEATS_SPLIT_NOTICE);
  });
});
