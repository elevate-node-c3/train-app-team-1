import {
  TICKET_LABELS,
  formatTicketDate,
  formatTicketDuration,
  formatTicketFare,
  formatTicketTime,
} from '@app/common';
import type { SupportedLanguage, TripEndpoint } from '@app/contracts';

import type { TextDirection } from './bidi-text.js';
import type { IssuedTicket } from './ticket-view.js';

export interface TicketDocumentRow {
  label: string;
  value: string;
}

/** What the printed ticket says, in one language; drawing it is separate. */
export interface TicketDocument {
  language: SupportedLanguage;
  direction: TextDirection;
  title: string;
  ticketNumber: string;
  route: string;
  rows: TicketDocumentRow[];
  qrPayload: string;
  qrCaption: string;
}

/**
 * The ticket's own snapshot, in the requested language: Arabic station and
 * class names for an Arabic ticket, English for an English one. Nothing is
 * looked up -- the snapshot already carries both.
 */
export function ticketDocumentOf(
  ticket: IssuedTicket,
  language: SupportedLanguage,
): TicketDocument {
  const { snapshot } = ticket;
  const labels = TICKET_LABELS[language];
  const from = snapshot.boarding.name[language];
  const to = snapshot.alighting.name[language];

  return {
    language,
    direction: language === 'ar' ? 'rtl' : 'ltr',
    title: labels.title,
    ticketNumber: `${labels.ticketNumber}: ${ticket.ticketNumber}`,
    // A dash reads the right way in both directions; the font has no arrows.
    route: `${from} — ${to}`,
    rows: [
      { label: labels.passenger, value: snapshot.passengerName },
      { label: labels.bookingCode, value: snapshot.bookingCode },
      {
        label: labels.train,
        value: `${snapshot.trainNumber} · ${snapshot.trainType[language]}`,
      },
      { label: labels.travelClass, value: snapshot.travelClass.name[language] },
      { label: labels.coach, value: String(ticket.coachNumber) },
      { label: labels.seat, value: ticket.seatNumber },
      {
        label: labels.departure,
        value: endpointText(snapshot.boarding, language),
      },
      {
        label: labels.arrival,
        value: endpointText(snapshot.alighting, language),
      },
      {
        label: labels.duration,
        value: formatTicketDuration(snapshot.durationMinutes, language),
      },
      {
        label: labels.fare,
        value: formatTicketFare(snapshot.farePiastres, language),
      },
    ],
    qrPayload: ticket.qrPayload,
    qrCaption: labels.qrCaption,
  };
}

/** Station, then its own Cairo date and time -- the passenger's, not the train's. */
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
