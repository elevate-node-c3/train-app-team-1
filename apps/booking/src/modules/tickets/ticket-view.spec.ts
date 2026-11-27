import { describe, expect, it } from 'vitest';

import { issuedTicket } from './testing/ticket-fixtures.js';
import {
  allowedActionsOf,
  isIssued,
  toConfirmedTicket,
  toSharedTicket,
  toTicketCard,
} from './ticket-view.js';

const HOUR_MS = 3_600_000;
const BEFORE_DEPARTURE = new Date('2099-01-10T08:00:00+02:00');
const ON_BOARD = new Date('2099-01-10T14:00:00+02:00');
const AFTER_ARRIVAL = new Date('2099-01-11T08:00:00+02:00');
const IN_ONE_HOUR = new Date(BEFORE_DEPARTURE.getTime() + HOUR_MS);
const IN_THREE_HOURS = new Date(BEFORE_DEPARTURE.getTime() + 3 * HOUR_MS);
const IN_SIX_HOURS = new Date(BEFORE_DEPARTURE.getTime() + 6 * HOUR_MS);

describe('allowedActionsOf (BR-39)', () => {
  it('lets an upcoming ticket be shared, shown and downloaded', () => {
    expect(allowedActionsOf(issuedTicket(), BEFORE_DEPARTURE)).toEqual({
      share: true,
      qr: true,
      download: true,
      cancel: true,
    });
  });

  it('keeps the QR while the passenger is still on board', () => {
    expect(allowedActionsOf(issuedTicket(), ON_BOARD)).toMatchObject({
      qr: true,
      share: true,
    });
  });

  it('keeps a completed journey as a receipt only', () => {
    expect(allowedActionsOf(issuedTicket(), AFTER_ARRIVAL)).toEqual({
      share: false,
      qr: false,
      download: true,
      cancel: false,
    });
  });

  it.each(['cancelled', 'voided'] as const)(
    'allows nothing on a %s ticket',
    (status) => {
      expect(
        allowedActionsOf(issuedTicket({ status }), BEFORE_DEPARTURE),
      ).toEqual({ share: false, qr: false, download: false, cancel: false });
    },
  );

  it('allows cancel for an active ticket more than 2 hours from boarding', () => {
    const ticket = issuedTicket({
      status: 'active',
      departsAt: IN_THREE_HOURS,
      arrivesAt: IN_SIX_HOURS,
    });
    expect(allowedActionsOf(ticket, BEFORE_DEPARTURE).cancel).toBe(true);
  });

  it('refuses cancel inside the 2-hour window', () => {
    const ticket = issuedTicket({
      status: 'active',
      departsAt: IN_ONE_HOUR,
      arrivesAt: IN_THREE_HOURS,
    });
    expect(allowedActionsOf(ticket, BEFORE_DEPARTURE).cancel).toBe(false);
  });

  it('refuses cancel for an already-cancelled ticket', () => {
    const ticket = issuedTicket({ status: 'cancelled' });
    expect(allowedActionsOf(ticket, BEFORE_DEPARTURE).cancel).toBe(false);
  });
});

describe('toTicketCard', () => {
  it('is everything a card shows, from the issued snapshot alone', () => {
    const card = toTicketCard(issuedTicket(), BEFORE_DEPARTURE);

    expect(card).toMatchObject({
      ticketId: '22222222-2222-4222-8222-222222222222',
      ticketNumber: 'TKT-1',
      bookingReference: '11111111-1111-4111-8111-111111111111',
      bookingCode: 'K7MQ2X',
      passengerName: 'Omar Khaled Hassan',
      trainNumber: 916,
      travelClass: { name: { en: 'Second Class AC' } },
      coachNumber: 3,
      seatNumber: '12',
      boarding: { name: { en: 'El Raml Station' } },
      alighting: { name: { en: 'Ramsis Station' } },
      durationMinutes: 210,
      farePiastres: 15500,
      currency: 'EGP',
      status: 'active',
      statusReason: '',
      refundStatus: '',
      allowedActions: { share: true, qr: true, download: true, cancel: true },
    });
  });

  it('carries the refund status written by cancellation', () => {
    const card = toTicketCard(
      issuedTicket({ refundStatus: 'pending' }),
      BEFORE_DEPARTURE,
    );
    expect(card.refundStatus).toBe('pending');
  });

  it('carries a cancellation reason', () => {
    const card = toTicketCard(
      issuedTicket({
        status: 'cancelled',
        statusReason: 'TRAVELLER_CANCELLED',
      }),
      BEFORE_DEPARTURE,
    );
    expect(card).toMatchObject({
      status: 'cancelled',
      statusReason: 'TRAVELLER_CANCELLED',
    });
  });
});

describe('toSharedTicket (BR-39)', () => {
  it('shows the ticket read-only, without the National ID or the booking', () => {
    const shared = toSharedTicket(issuedTicket());

    expect(Object.keys(shared).sort()).toEqual([
      'alighting',
      'boarding',
      'coachNumber',
      'durationMinutes',
      'expiresAt',
      'passengerName',
      'seatNumber',
      'ticketNumber',
      'trainNumber',
      'trainType',
      'travelClass',
    ]);
    expect(JSON.stringify(shared)).not.toContain('1234');
    expect(shared.expiresAt).toBe('2099-01-10T14:00:00.000Z');
  });
});

describe('toConfirmedTicket', () => {
  it('hands the email its ticket and signed QR, never the National ID', () => {
    const confirmed = toConfirmedTicket(issuedTicket());

    expect(confirmed).toMatchObject({
      ticketNumber: 'TKT-1',
      ticketId: '22222222-2222-4222-8222-222222222222',
      passengerName: 'Omar Khaled Hassan',
      travelClass: { en: 'Second Class AC', ar: 'الدرجة الثانية مكيفة' },
      qr: 'header.payload.signature',
    });
    expect(JSON.stringify(confirmed)).not.toContain('nationalId');
  });
});

describe('isIssued', () => {
  it('treats a ticket issued before snapshots existed as having nothing to print', () => {
    expect(isIssued(issuedTicket())).toBe(true);
    expect(isIssued(issuedTicket({ snapshot: null } as never))).toBe(false);
    expect(isIssued(null)).toBe(false);
  });
});
