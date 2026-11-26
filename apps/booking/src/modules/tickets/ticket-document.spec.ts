import { describe, expect, it } from 'vitest';

import { civil, issuedTicket, quotedLeg } from './testing/ticket-fixtures.js';
import { ticketDocumentOf } from './ticket-document.js';

const valueOf = (
  document: ReturnType<typeof ticketDocumentOf>,
  label: string,
): string | undefined =>
  document.rows.find((row) => row.label === label)?.value;

describe('ticketDocumentOf (the printed ticket)', () => {
  it('prints an English ticket left to right, in English', () => {
    const document = ticketDocumentOf(issuedTicket(), 'en');

    expect(document.direction).toBe('ltr');
    expect(document.title).toBe('Train Ticket');
    expect(document.ticketNumber).toBe('Ticket number: TKT-1');
    expect(document.route).toBe('El Raml Station — Ramsis Station');
    expect(document.rows).toEqual([
      { label: 'Passenger', value: 'Omar Khaled Hassan' },
      { label: 'Booking code', value: 'K7MQ2X' },
      { label: 'Train', value: '916 · Express' },
      { label: 'Class', value: 'Second Class AC' },
      { label: 'Coach', value: '3' },
      { label: 'Seat', value: '12' },
      {
        label: 'Departure',
        value: 'El Raml Station · 10 Jan, 2099 · 12:30 PM',
      },
      { label: 'Arrival', value: 'Ramsis Station · 10 Jan, 2099 · 04:00 PM' },
      { label: 'Duration', value: '3hr 30mins' },
      { label: 'Fare', value: '155.00 EGP' },
    ]);
    expect(document.qrPayload).toBe('header.payload.signature');
  });

  it('prints an Arabic ticket right to left, with Arabic stations and class', () => {
    const document = ticketDocumentOf(issuedTicket(), 'ar');

    expect(document.direction).toBe('rtl');
    expect(document.title).toBe('تذكرة قطار');
    expect(document.route).toBe('محطة الرمل — محطة رمسيس');
    expect(valueOf(document, 'الدرجة')).toBe('الدرجة الثانية مكيفة');
    expect(valueOf(document, 'المغادرة')).toBe(
      'محطة الرمل · 10 يناير 2099 · 12:30 م',
    );
    expect(valueOf(document, 'مدة الرحلة')).toBe('3 س 30 د');
    expect(valueOf(document, 'السعر')).toBe('155.00 ج.م');
    expect(document.qrCaption).toBe('اعرض هذا الرمز على مفتش القطار');
  });

  it("dates an overnight boarding by the passenger's station", () => {
    const leg = quotedLeg('trip-1', {
      from: { en: 'Assiut', ar: 'أسيوط' },
      departs: '2099-12-02T04:10:00+02:00',
    });
    const ticket = issuedTicket();
    ticket.snapshot = {
      ...ticket.snapshot,
      boarding: { ...leg.departure, at: civil('2099-12-02T04:10:00+02:00') },
    };

    expect(valueOf(ticketDocumentOf(ticket, 'en'), 'Departure')).toBe(
      'Assiut · 2 Dec, 2099 · 04:10 AM',
    );
  });

  it('never prints the National ID', () => {
    for (const language of ['en', 'ar'] as const) {
      expect(
        JSON.stringify(ticketDocumentOf(issuedTicket(), language)),
      ).not.toContain('1234');
    }
  });
});
