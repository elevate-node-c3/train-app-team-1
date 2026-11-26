import {
  TICKET_LABELS,
  formatTicketDate,
  formatTicketDuration,
  formatTicketFare,
  formatTicketTime,
} from '@app/common';
import type {
  BookingConfirmedPayloadV1,
  BookingConfirmedTicketV1,
  SupportedLanguage,
  TripEndpoint,
} from '@app/contracts';

import {
  escapeHtml,
  type EmailContent,
} from '../booking-outcomes/booking-outcome.template.js';

/** The inline QR image's content id; the HTML shows it as `cid:<id>`. */
export function qrContentId(ticketNumber: string): string {
  return `qr-${ticketNumber}@tickets`;
}

const COPY: Readonly<
  Record<
    SupportedLanguage,
    {
      subject: (code: string) => string;
      intro: (code: string) => string;
      total: string;
    }
  >
> = {
  en: {
    subject: (code) => `Your tickets for booking ${code}`,
    intro: (code) =>
      `Your booking ${code} is confirmed. Each passenger shows their own QR code to the conductor.`,
    total: 'Total paid',
  },
  ar: {
    subject: (code) => `تذاكرك للحجز ${code}`,
    intro: (code) =>
      `تم تأكيد حجزك ${code}. يعرض كل مسافر رمز QR الخاص به على مفتش القطار.`,
    total: 'إجمالي المدفوع',
  },
};

/**
 * One email for the whole booking (BR-53): every ticket, each with its QR,
 * in the account's language -- not the language of the request that
 * happened to confirm it.
 */
export function renderBookingConfirmedEmail(
  payload: BookingConfirmedPayloadV1,
  language: SupportedLanguage,
): EmailContent {
  const copy = COPY[language];
  const labels = TICKET_LABELS[language];
  const tickets = payload.tickets.map((ticket) => ({
    ticket,
    rows: rowsOf(ticket, language),
  }));
  const total = `${copy.total}: ${formatTicketFare(payload.totalPiastres, language)}`;

  const text = [
    copy.intro(payload.bookingCode),
    '',
    ...tickets.flatMap(({ ticket, rows }) => [
      `${labels.ticketNumber}: ${ticket.ticketNumber}`,
      ...rows.map(([label, value]) => `${label}: ${value}`),
      '',
    ]),
    total,
  ].join('\n');

  const dir = language === 'ar' ? 'rtl' : 'ltr';
  const align = language === 'ar' ? 'right' : 'left';
  const cards = tickets
    .map(
      ({ ticket, rows }) => `
      <div style="border:1px solid #d5dce2;border-radius:8px;padding:16px;margin:16px 0">
        <p style="margin:0 0 8px;font-weight:bold">${escapeHtml(labels.ticketNumber)}: ${escapeHtml(ticket.ticketNumber)}</p>
        <table style="border-collapse:collapse;text-align:${align}">
          ${rows
            .map(
              ([label, value]) =>
                `<tr><td style="color:#5f6b76;padding:2px 12px 2px 0">${escapeHtml(label)}</td><td style="font-weight:bold;padding:2px 12px 2px 0">${escapeHtml(value)}</td></tr>`,
            )
            .join('')}
        </table>
        <img src="cid:${qrContentId(ticket.ticketNumber)}" width="180" height="180" alt="QR ${escapeHtml(ticket.ticketNumber)}" style="display:block;margin-top:12px">
        <p style="margin:4px 0 0;color:#5f6b76">${escapeHtml(labels.qrCaption)}</p>
      </div>`,
    )
    .join('');
  const html = `
    <div dir="${dir}" lang="${language}" style="text-align:${align};font-family:Arial,Tahoma,sans-serif">
      <p>${escapeHtml(copy.intro(payload.bookingCode))}</p>
      ${cards}
      <p style="font-weight:bold">${escapeHtml(total)}</p>
    </div>
  `;

  return { subject: copy.subject(payload.bookingCode), text, html };
}

function rowsOf(
  ticket: BookingConfirmedTicketV1,
  language: SupportedLanguage,
): [string, string][] {
  const labels = TICKET_LABELS[language];
  return [
    [labels.passenger, ticket.passengerName],
    [labels.train, String(ticket.trainNumber)],
    [labels.travelClass, ticket.travelClass[language]],
    [labels.coach, String(ticket.coachNumber)],
    [labels.seat, ticket.seatNumber],
    [labels.departure, endpointText(ticket.boarding, language)],
    [labels.arrival, endpointText(ticket.alighting, language)],
    [labels.duration, formatTicketDuration(ticket.durationMinutes, language)],
    [labels.fare, formatTicketFare(ticket.farePiastres, language)],
  ];
}

function endpointText(
  endpoint: TripEndpoint,
  language: SupportedLanguage,
): string {
  return [
    endpoint.name[language],
    formatTicketDate(endpoint.at.localDate, language),
    formatTicketTime(endpoint.at.localTime, language),
  ].join(' · ');
}
