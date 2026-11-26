import { generateKeyPairSync } from 'node:crypto';
import type { QuotedLeg, TravelClass } from '@app/contracts';

import {
  BookingDraftEntity,
  type SettledSeat,
} from '../../draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../../flow/entities/ticket.entity.js';
import { TicketSignerService } from '../services/ticket-signer.service.js';
import type { IssuedTicket } from '../ticket-view.js';

/** Shared by the tickets module's specs; never imported by production code. */
export const TRAVEL_CLASS: TravelClass = {
  id: '00000000-0000-4000-8000-00000000c1a5',
  name: { en: 'Second Class AC', ar: 'الدرجة الثانية مكيفة' },
};

export function civil(iso: string) {
  return {
    localDate: iso.slice(0, 10),
    localTime: iso.slice(11, 16),
    utcOffset: iso.slice(19),
    iso,
    timeZone: 'Africa/Cairo',
  };
}

export function quotedLeg(
  tripId: string,
  options: {
    departs?: string;
    arrives?: string;
    from?: { en: string; ar: string };
    to?: { en: string; ar: string };
    trainNumber?: number;
    farePiastres?: number;
  } = {},
): QuotedLeg {
  return {
    tripId,
    trainNumber: options.trainNumber ?? 916,
    trainType: { en: 'Express', ar: 'إكسبريس' },
    departure: {
      stationId: 'station-from',
      name: options.from ?? { en: 'El Raml Station', ar: 'محطة الرمل' },
      at: civil(options.departs ?? '2099-01-10T12:30:00+02:00'),
    },
    arrival: {
      stationId: 'station-to',
      name: options.to ?? { en: 'Ramsis Station', ar: 'محطة رمسيس' },
      at: civil(options.arrives ?? '2099-01-10T16:00:00+02:00'),
    },
    fare: { amountMinor: options.farePiastres ?? 15500, currency: 'EGP' },
  };
}

export function draftWith(props: {
  passengers: { ref: string; name: string; maskedNationalId?: string }[];
  legs: QuotedLeg[];
  seats: SettledSeat[];
}): BookingDraftEntity {
  return Object.assign(new BookingDraftEntity(), {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'owner-1',
    travelClass: TRAVEL_CLASS,
    quotedLegs: props.legs,
    passengerSnapshot: props.passengers.map((passenger) => ({
      passengerRef: passenger.ref,
      displayName: passenger.name,
      maskedNationalId: passenger.maskedNationalId ?? '**********1234',
      identities: [],
    })),
    settledSeats: props.seats,
  });
}

export function signerWithNewKey(
  keyId = 'ticket-test-1',
  retiredPublicKeys: { kid: string; publicKeyPem: string }[] = [],
): { signer: TicketSignerService; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = new TicketSignerService();
  signer.load({
    keyId,
    privateKeyPem: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    retiredPublicKeys,
  });
  return {
    signer,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** An issued ticket as the repository returns it. */
export function issuedTicket(
  overrides: Partial<IssuedTicket> = {},
): IssuedTicket {
  const leg = quotedLeg('trip-1');
  return Object.assign(new TicketEntity(), {
    id: '22222222-2222-4222-8222-222222222222',
    bookingReference: '11111111-1111-4111-8111-111111111111',
    passengerRef: 'p1',
    tripId: 'trip-1',
    ticketNumber: 'TKT-1',
    coachNumber: 3,
    seatNumber: '12',
    createdAt: new Date('2099-01-01T00:00:00Z'),
    ownerId: 'owner-1',
    departsAt: new Date(leg.departure.at.iso),
    arrivesAt: new Date(leg.arrival.at.iso),
    qrPayload: 'header.payload.signature',
    status: 'active',
    statusReason: null,
    statusChangedAt: null,
    snapshot: {
      bookingCode: 'K7MQ2X',
      passengerName: 'Omar Khaled Hassan',
      nationalIdLast4: '1234',
      trainNumber: 916,
      trainType: leg.trainType,
      travelClass: TRAVEL_CLASS,
      boarding: leg.departure,
      alighting: leg.arrival,
      durationMinutes: 210,
      farePiastres: 15500,
    },
    ...overrides,
  }) as IssuedTicket;
}
