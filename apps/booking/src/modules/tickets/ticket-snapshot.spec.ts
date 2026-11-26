import { describe, expect, it } from 'vitest';

import { BookingFlowFault } from '../flow/booking-flow-error.js';
import {
  isTicketQrClaims,
  newBookingCode,
  qrClaimsOf,
  ticketSnapshotOf,
} from './ticket-snapshot.js';
import {
  TRAVEL_CLASS,
  draftWith,
  quotedLeg,
} from './testing/ticket-fixtures.js';

describe('ticketSnapshotOf (TA-108, BR-22, BR-37)', () => {
  const leg = quotedLeg('trip-1', {
    from: { en: 'Assiut', ar: 'أسيوط' },
    to: { en: 'Aswan', ar: 'أسوان' },
  });
  const draft = draftWith({
    passengers: [
      { ref: 'p1', name: 'Mona Ahmed', maskedNationalId: '**********9876' },
    ],
    legs: [leg],
    seats: [
      {
        passengerRef: 'p1',
        tripId: 'trip-1',
        coachNumber: 5,
        seatNumber: '44',
      },
    ],
  });

  it('copies everything the ticket prints from what the draft locked', () => {
    const snapshot = ticketSnapshotOf(draft, draft.settledSeats![0], 'K7MQ2X');

    expect(snapshot).toEqual({
      bookingCode: 'K7MQ2X',
      passengerName: 'Mona Ahmed',
      nationalIdLast4: '9876',
      trainNumber: 916,
      trainType: { en: 'Express', ar: 'إكسبريس' },
      travelClass: TRAVEL_CLASS,
      boarding: leg.departure,
      alighting: leg.arrival,
      durationMinutes: 210,
      farePiastres: 15500,
    });
  });

  it("prints the passenger's own stations, not the train's first and last", () => {
    const snapshot = ticketSnapshotOf(draft, draft.settledSeats![0], 'K7MQ2X');

    expect(snapshot.boarding.name).toEqual({ en: 'Assiut', ar: 'أسيوط' });
    expect(snapshot.alighting.name).toEqual({ en: 'Aswan', ar: 'أسوان' });
  });

  it('carries the class in plain words in both languages (BR-22)', () => {
    const snapshot = ticketSnapshotOf(draft, draft.settledSeats![0], 'K7MQ2X');

    expect(snapshot.travelClass.name).toEqual({
      en: 'Second Class AC',
      ar: 'الدرجة الثانية مكيفة',
    });
  });

  it('dates an overnight boarding by the passenger station, not the origin', () => {
    // The train leaves its origin at 22:00 on 1 Dec; this passenger boards
    // at Assiut at 04:10 the next day, which is what catalog quoted.
    const overnight = draftWith({
      passengers: [{ ref: 'p1', name: 'Mona Ahmed' }],
      legs: [
        quotedLeg('trip-1', {
          from: { en: 'Assiut', ar: 'أسيوط' },
          departs: '2099-12-02T04:10:00+02:00',
          arrives: '2099-12-02T09:40:00+02:00',
        }),
      ],
      seats: [
        {
          passengerRef: 'p1',
          tripId: 'trip-1',
          coachNumber: 1,
          seatNumber: '1',
        },
      ],
    });

    const snapshot = ticketSnapshotOf(
      overnight,
      overnight.settledSeats![0],
      'K7MQ2X',
    );
    const claims = qrClaimsOf('TKT-9', snapshot, 1, '1');

    expect(snapshot.boarding.at.localDate).toBe('2099-12-02');
    expect(snapshot.boarding.at.localTime).toBe('04:10');
    expect(claims.boardingDate).toBe('2099-12-02');
    expect(snapshot.durationMinutes).toBe(330);
  });

  it('keeps only the last four National ID digits (BR-38)', () => {
    const snapshot = ticketSnapshotOf(draft, draft.settledSeats![0], 'K7MQ2X');

    expect(snapshot.nationalIdLast4).toBe('9876');
    expect(Object.keys(snapshot)).not.toContain('nationalId');
    expect(Object.keys(snapshot)).not.toContain('maskedNationalId');
  });

  it('refuses a seat it cannot print rather than inventing a ticket', () => {
    expect(() =>
      ticketSnapshotOf(
        draft,
        {
          passengerRef: 'p1',
          tripId: 'unknown-trip',
          coachNumber: 1,
          seatNumber: '1',
        },
        'K7MQ2X',
      ),
    ).toThrow(BookingFlowFault);
    expect(() =>
      ticketSnapshotOf(
        draft,
        {
          passengerRef: 'unknown',
          tripId: 'trip-1',
          coachNumber: 1,
          seatNumber: '1',
        },
        'K7MQ2X',
      ),
    ).toThrow(BookingFlowFault);
  });
});

describe('qrClaimsOf (BR-38)', () => {
  it('signs exactly what a conductor checks', () => {
    const draft = draftWith({
      passengers: [{ ref: 'p1', name: 'Mona Ahmed' }],
      legs: [quotedLeg('trip-1')],
      seats: [
        {
          passengerRef: 'p1',
          tripId: 'trip-1',
          coachNumber: 3,
          seatNumber: '12',
        },
      ],
    });
    const snapshot = ticketSnapshotOf(draft, draft.settledSeats![0], 'K7MQ2X');

    expect(Object.keys(qrClaimsOf('TKT-1', snapshot, 3, '12')).sort()).toEqual([
      'alightingStation',
      'boardingDate',
      'boardingStation',
      'coachNumber',
      'nationalIdLast4',
      'passengerName',
      'seatNumber',
      'ticketNumber',
      'trainNumber',
    ]);
  });

  it('accepts only its own shape, and never a full National ID', () => {
    const claims = {
      ticketNumber: 'TKT-1',
      trainNumber: 916,
      boardingDate: '2099-01-10',
      boardingStation: { en: 'A', ar: 'أ' },
      alightingStation: { en: 'B', ar: 'ب' },
      coachNumber: 3,
      seatNumber: '12',
      passengerName: 'Mona Ahmed',
      nationalIdLast4: '1234',
    };

    expect(isTicketQrClaims(claims)).toBe(true);
    expect(
      isTicketQrClaims({ ...claims, nationalIdLast4: '29801011234567' }),
    ).toBe(false);
    expect(isTicketQrClaims({ ...claims, coachNumber: '3' })).toBe(false);
    expect(isTicketQrClaims(null)).toBe(false);
  });
});

describe('newBookingCode', () => {
  it('is six characters that survive being read aloud', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(newBookingCode()).toMatch(/^[A-HJKMNPQRT-Z2346789]{6}$/);
      expect(newBookingCode()).not.toMatch(/[01ILOS5]/);
    }
  });
});
