import { randomInt } from 'node:crypto';
import {
  durationMinutesBetween,
  type LocalizedName,
  type TicketQrClaims,
} from '@app/contracts';

import type {
  BookingDraftEntity,
  SettledSeat,
} from '../draft/entities/booking-draft.entity.js';
import type { TicketSnapshot } from '../flow/entities/ticket.entity.js';
import { BookingFlowFault } from '../flow/booking-flow-error.js';

/** No 0/O, 1/I/L or 5/S: a code read over the phone survives the reading. */
const BOOKING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';
const BOOKING_CODE_LENGTH = 6;

export function newBookingCode(): string {
  let code = '';
  for (let index = 0; index < BOOKING_CODE_LENGTH; index += 1) {
    code += BOOKING_CODE_ALPHABET[randomInt(BOOKING_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The ticket as it will be printed, from what the draft already locked: the
 * passenger as identity resolved them at the hold, and the leg exactly as
 * catalog quoted it -- the passenger's own boarding and alighting stations
 * with their Cairo dates and times, never the train's first and last stops.
 *
 * Nothing here reads a live passenger or timetable, which is the point.
 */
export function ticketSnapshotOf(
  draft: BookingDraftEntity,
  seat: SettledSeat,
  bookingCode: string,
): TicketSnapshot {
  const leg = draft.quotedLegs?.find((quoted) => quoted.tripId === seat.tripId);
  const passenger = draft.passengerSnapshot?.find(
    (candidate) => candidate.passengerRef === seat.passengerRef,
  );
  if (!leg || !passenger || !draft.travelClass) {
    throw new BookingFlowFault(
      'A settled seat has no quoted leg, passenger or class to print',
    );
  }

  return {
    bookingCode,
    passengerName: passenger.displayName,
    nationalIdLast4: lastFourDigits(passenger.maskedNationalId),
    trainNumber: leg.trainNumber,
    trainType: leg.trainType,
    travelClass: draft.travelClass,
    boarding: leg.departure,
    alighting: leg.arrival,
    durationMinutes: durationMinutesBetween(
      new Date(leg.departure.at.iso),
      new Date(leg.arrival.at.iso),
    ),
    farePiastres: leg.fare.amountMinor,
  };
}

/** What the QR signs (BR-38): what a conductor checks, and nothing more. */
export function qrClaimsOf(
  ticketNumber: string,
  snapshot: TicketSnapshot,
  coachNumber: number,
  seatNumber: string,
): TicketQrClaims {
  return {
    ticketNumber,
    trainNumber: snapshot.trainNumber,
    // The date at the passenger's own station: an overnight train that left
    // its origin yesterday is boarded today.
    boardingDate: snapshot.boarding.at.localDate,
    boardingStation: snapshot.boarding.name,
    alightingStation: snapshot.alighting.name,
    coachNumber,
    seatNumber,
    passengerName: snapshot.passengerName,
    nationalIdLast4: snapshot.nationalIdLast4,
  };
}

/** A verified payload is still only trusted once its shape is ours. */
export function isTicketQrClaims(value: unknown): value is TicketQrClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.ticketNumber === 'string' &&
    Number.isSafeInteger(claims.trainNumber) &&
    typeof claims.boardingDate === 'string' &&
    isLocalizedName(claims.boardingStation) &&
    isLocalizedName(claims.alightingStation) &&
    Number.isSafeInteger(claims.coachNumber) &&
    typeof claims.seatNumber === 'string' &&
    typeof claims.passengerName === 'string' &&
    typeof claims.nationalIdLast4 === 'string' &&
    /^\d{4}$/.test(claims.nationalIdLast4)
  );
}

function isLocalizedName(value: unknown): value is LocalizedName {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LocalizedName).en === 'string' &&
    typeof (value as LocalizedName).ar === 'string'
  );
}

/** Identity masks as '**********1234'; only those four digits ever travel. */
function lastFourDigits(maskedNationalId: string): string {
  const digits = maskedNationalId.replace(/\D/g, '');
  if (digits.length < 4) {
    throw new BookingFlowFault('The passenger has no National ID to print');
  }
  return digits.slice(-4);
}
