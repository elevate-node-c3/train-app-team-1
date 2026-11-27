import type {
  BookingConfirmedTicketV1,
  SharedTicket,
  TicketActions,
  TicketCard,
} from '@app/contracts';

import type {
  TicketEntity,
  TicketSnapshot,
} from '../flow/entities/ticket.entity.js';
import { BOOKING_CURRENCY } from '../flow/booking-total.js';
import { quoteCancellation } from '../flow/services/ticket-cancellation-policy.js';

/** A ticket issued with its snapshot; older rows have nothing to print. */
export type IssuedTicket = TicketEntity & {
  ownerId: string;
  snapshot: TicketSnapshot;
  departsAt: Date;
  arrivesAt: Date;
  qrPayload: string;
};

export function isIssued(
  ticket: TicketEntity | null | undefined,
): ticket is IssuedTicket {
  return Boolean(
    ticket?.ownerId &&
    ticket.snapshot &&
    ticket.departsAt &&
    ticket.arrivesAt &&
    ticket.qrPayload,
  );
}

/**
 * A ticket stays upcoming until the passenger arrives, so a journey in
 * progress -- when the conductor actually checks it -- keeps its QR.
 */
export function isUpcoming(ticket: IssuedTicket, now: Date): boolean {
  return ticket.status === 'active' && ticket.arrivesAt > now;
}

/**
 * The one answer to "what may be done with this ticket", used both to tell
 * the client and to refuse a call that ignores it (BR-39).
 */
export function allowedActionsOf(
  ticket: IssuedTicket,
  now: Date,
): TicketActions {
  const upcoming = isUpcoming(ticket, now);
  return {
    share: upcoming,
    qr: upcoming,
    // A completed journey's ticket is still a receipt; a cancelled one is not.
    download: ticket.status === 'active',
    cancel: canCancel(ticket, now),
  };
}

/** Cancellation uses BOOK-4's policy, with no delay or trip cancellation. */
function canCancel(ticket: IssuedTicket, now: Date): boolean {
  return (
    ticket.status === 'active' &&
    quoteCancellation({
      departsAt: ticket.departsAt,
      now,
      farePiastres: ticket.snapshot.farePiastres,
      delayMinutes: 0,
      tripCancelled: false,
    }).allowed
  );
}

/**
 * Refund statuses are PAY-3's. TODO(TA-110): read them from PAY-3 once
 * booking learns them; only 'pending' is written this sprint.
 */
function refundStatusOf(ticket: IssuedTicket): string {
  return ticket.refundStatus ?? '';
}

export function toTicketCard(ticket: IssuedTicket, now: Date): TicketCard {
  const { snapshot } = ticket;
  return {
    ticketId: ticket.id,
    ticketNumber: ticket.ticketNumber,
    bookingReference: ticket.bookingReference,
    bookingCode: snapshot.bookingCode,
    passengerName: snapshot.passengerName,
    trainNumber: snapshot.trainNumber,
    trainType: snapshot.trainType,
    travelClass: snapshot.travelClass,
    coachNumber: ticket.coachNumber,
    seatNumber: ticket.seatNumber,
    boarding: snapshot.boarding,
    alighting: snapshot.alighting,
    durationMinutes: snapshot.durationMinutes,
    farePiastres: snapshot.farePiastres,
    currency: BOOKING_CURRENCY,
    status: ticket.status,
    statusReason: ticket.statusReason ?? '',
    refundStatus: refundStatusOf(ticket),
    allowedActions: allowedActionsOf(ticket, now),
  };
}

/** Read-only: no National ID, no booking identifiers, no actions. */
export function toSharedTicket(ticket: IssuedTicket): SharedTicket {
  const { snapshot } = ticket;
  return {
    ticketNumber: ticket.ticketNumber,
    passengerName: snapshot.passengerName,
    trainNumber: snapshot.trainNumber,
    trainType: snapshot.trainType,
    travelClass: snapshot.travelClass,
    coachNumber: ticket.coachNumber,
    seatNumber: ticket.seatNumber,
    boarding: snapshot.boarding,
    alighting: snapshot.alighting,
    durationMinutes: snapshot.durationMinutes,
    expiresAt: ticket.arrivesAt.toISOString(),
  };
}

/** A ticket as booking.confirmed carries it to the confirmation email. */
export function toConfirmedTicket(
  ticket: IssuedTicket,
): BookingConfirmedTicketV1 {
  const { snapshot } = ticket;
  return {
    ticketNumber: ticket.ticketNumber,
    passengerRef: ticket.passengerRef,
    tripId: ticket.tripId,
    coachNumber: ticket.coachNumber,
    seatNumber: ticket.seatNumber,
    ticketId: ticket.id,
    passengerName: snapshot.passengerName,
    trainNumber: snapshot.trainNumber,
    travelClass: snapshot.travelClass.name,
    boarding: snapshot.boarding,
    alighting: snapshot.alighting,
    durationMinutes: snapshot.durationMinutes,
    farePiastres: snapshot.farePiastres,
    qr: ticket.qrPayload,
  };
}
