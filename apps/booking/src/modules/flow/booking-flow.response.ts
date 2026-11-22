import {
  AllocationOutcome,
  SEATS_SPLIT_NOTICE,
  type BookedLeg,
  type BookedPassenger,
  type BookingResponse,
  type Ticket,
} from '@app/contracts';

import type { BookingDraftEntity } from '../draft/entities/booking-draft.entity.js';
import type { TicketEntity } from './entities/ticket.entity.js';
import { BOOKING_CURRENCY, BOOKING_FEE_PERCENT } from './booking-total.js';

/** One seat, whichever source it came from. */
interface SeatView {
  tripId: string;
  passengerRef: string;
  coachNumber: number;
  seatNumber: string;
  outcome?: AllocationOutcome;
  label?: string;
}

/**
 * Everything the Review Tickets step needs, built only from the stored draft:
 * the snapshot names, the locked fares, and inventory's seats and expiry.
 *
 * A read never resets the expiry, and serverTime is always fresh, so a second
 * phone or a reload shows the same reservation time (SEAT-3).
 */
export function toBookingResponse(
  draft: BookingDraftEntity,
  tickets: readonly TicketEntity[] = [],
  now: Date = new Date(),
): BookingResponse {
  const assignments = seatsOf(draft);

  const legs: BookedLeg[] = (draft.quotedLegs ?? []).map((quoted) => {
    const forLeg = assignments.filter(
      (assignment) => assignment.tripId === quoted.tripId,
    );
    const farePiastres = quoted.fare.amountMinor;

    return {
      tripId: quoted.tripId,
      trainNumber: quoted.trainNumber,
      trainType: quoted.trainType,
      departure: quoted.departure,
      arrival: quoted.arrival,
      farePiastres,
      allocationOutcome: outcomeOf(forLeg),
      ...splitNoticeOf(draft, quoted.tripId),
      passengers: passengersOf(draft, forLeg, farePiastres),
    };
  });

  return {
    bookingReference: draft.id,
    state: draft.flowState ?? '',
    totalPiastres: draft.totalPiastres ?? 0,
    currency: BOOKING_CURRENCY,
    holdExpiresAt: draft.expiresAt?.toISOString() ?? '',
    paymentReference: draft.paymentReference ?? '',
    clientSecret:
      draft.flowState === 'awaiting_payment' &&
      draft.expiresAt &&
      draft.expiresAt > now
        ? (draft.paymentClientSecret ?? '')
        : '',
    serverTime: now.toISOString(),
    ...(draft.travelClass ? { travelClass: draft.travelClass } : {}),
    legs,
    fareTotalPiastres: draft.fareTotalPiastres ?? 0,
    bookingFeePiastres: draft.bookingFeePiastres ?? 0,
    bookingFeePercent: BOOKING_FEE_PERCENT,
    termsAcceptedAt: draft.termsAcceptedAt?.toISOString() ?? '',
    tickets: tickets.map(ticketViewOf),
    seatsChanged: draft.seatsChanged ?? false,
  };
}

function ticketViewOf(ticket: TicketEntity): Ticket {
  return {
    ticketNumber: ticket.ticketNumber,
    passengerRef: ticket.passengerRef,
    tripId: ticket.tripId,
    coachNumber: ticket.coachNumber,
    seatNumber: ticket.seatNumber,
  };
}

/**
 * The seats the traveller actually has. A reallocated booking's
 * `settled_seats` is preferred over the original hold snapshot, which may
 * name seats someone else now holds.
 */
function seatsOf(draft: BookingDraftEntity): SeatView[] {
  if (draft.settledSeats) {
    return draft.settledSeats.map((seat) => ({
      tripId: seat.tripId,
      passengerRef: seat.passengerRef,
      coachNumber: seat.coachNumber,
      seatNumber: seat.seatNumber,
      outcome:
        seat.outcome ??
        (!draft.seatsChanged
          ? draft.holdSnapshot?.assignments.find(
              (held) =>
                held.tripId === seat.tripId &&
                held.passengerRef === seat.passengerRef,
            )?.outcome
          : undefined),
      label: seat.label,
    }));
  }

  return (draft.holdSnapshot?.assignments ?? []).map((assignment) => ({
    tripId: assignment.tripId,
    passengerRef: assignment.passengerRef,
    coachNumber: assignment.coachNumber,
    seatNumber: assignment.seatNumber,
    outcome: assignment.outcome,
    label: assignment.label,
  }));
}

/** Every assignment on a leg shares its outcome; empty before the hold. */
function outcomeOf(assignments: readonly SeatView[]): AllocationOutcome | '' {
  return assignments[0]?.outcome ?? '';
}

function splitNoticeOf(
  draft: BookingDraftEntity,
  tripId: string,
): Pick<BookedLeg, 'splitNotice'> | Record<string, never> {
  if (draft.settledSeats) {
    return outcomeOf(
      seatsOf(draft).filter((seat) => seat.tripId === tripId),
    ) === AllocationOutcome.SPLIT
      ? { splitNotice: SEATS_SPLIT_NOTICE }
      : {};
  }
  const leg = draft.legs.find((candidate) => candidate.tripId === tripId);
  return leg?.splitNotice ? { splitNotice: leg.splitNotice } : {};
}

/**
 * The passenger snapshot is the order the traveller chose, and every
 * assignment names the passenger it went to, so no positional pairing is
 * needed to say who sits where.
 */
function passengersOf(
  draft: BookingDraftEntity,
  assignments: readonly SeatView[],
  farePiastres: number,
): BookedPassenger[] {
  return (draft.passengerSnapshot ?? []).map((passenger) => {
    const seat = assignments.find(
      (assignment) => assignment.passengerRef === passenger.passengerRef,
    );
    const label =
      seat?.label ??
      (seat ? `Coach ${seat.coachNumber} · Seat ${seat.seatNumber}` : '');

    return {
      passengerId: passenger.passengerRef,
      fullName: passenger.displayName,
      coachNumber: seat?.coachNumber ?? 0,
      seatNumber: seat?.seatNumber ?? '',
      seatLabel: seat ? `${passenger.displayName} · ${label}` : '',
      farePiastres,
    };
  });
}
