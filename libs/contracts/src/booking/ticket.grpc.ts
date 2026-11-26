import type {
  LocalizedName,
  TravelClass,
  TripEndpoint,
} from '../catalog/catalog.dto.js';
import type { SupportedLanguage } from '../events/event-envelope.js';

/** Served from booking.proto, beside BookingService. */
export const TICKET_SERVICE_NAME = 'TicketService';

export type TicketStatus = 'active' | 'cancelled' | 'voided';

export interface ListTicketsRequest {
  /** 0 means the default page size. */
  limit: number;
  /** '' for the first page; the previous page's nextCursor afterwards. */
  cursor: string;
}

export interface TicketRequest {
  ticketId: string;
}

export interface TicketPdfRequest {
  ticketId: string;
  /** The request's language, resolved at the edge; not the account's. */
  language: SupportedLanguage;
}

export interface SharedTicketRequest {
  token: string;
}

export interface VerifyTicketRequest {
  qr: string;
}

/** What may be done with a ticket right now; booking decides, not the client. */
export interface TicketActions {
  share: boolean;
  qr: boolean;
  download: boolean;
  cancel: boolean;
}

/** Everything a ticket card shows, from the ticket's own issued snapshot. */
export interface TicketCard {
  ticketId: string;
  ticketNumber: string;
  bookingReference: string;
  /** Short and read aloud; every ticket of one booking shares it. */
  bookingCode: string;
  passengerName: string;
  trainNumber: number;
  trainType: LocalizedName;
  /** Plain words in both languages (BR-22). */
  travelClass: TravelClass;
  coachNumber: number;
  seatNumber: string;
  /** The passenger's own boarding station and Cairo time, not the train's. */
  boarding: TripEndpoint;
  alighting: TripEndpoint;
  durationMinutes: number;
  farePiastres: number;
  currency: string;
  status: TicketStatus;
  statusReason: string;
  /** '' until PAY-3 reports one. */
  refundStatus: string;
  allowedActions: TicketActions;
}

export interface TicketPage {
  tickets: TicketCard[];
  /** '' on the last page. */
  nextCursor: string;
}

export interface TicketQr {
  /** The signed QR content, exactly as encoded in the image. */
  payload: string;
  keyId: string;
  /** data:image/png;base64,... */
  image: string;
}

export interface TicketShareLink {
  token: string;
  /** The arrival at the passenger's alighting station (ISO instant). */
  expiresAt: string;
}

export interface TicketPdf {
  content: Buffer;
  fileName: string;
}

/** Read-only, and never the National ID or the booking's other tickets. */
export interface SharedTicket {
  ticketNumber: string;
  passengerName: string;
  trainNumber: number;
  trainType: LocalizedName;
  travelClass: TravelClass;
  coachNumber: number;
  seatNumber: string;
  boarding: TripEndpoint;
  alighting: TripEndpoint;
  durationMinutes: number;
  expiresAt: string;
}

export type TicketVerificationResult =
  | 'VALID'
  | 'MALFORMED'
  | 'INVALID_SIGNATURE'
  | 'UNKNOWN_TICKET'
  | 'CANCELLED'
  | 'VOIDED';

export interface TicketVerification {
  valid: boolean;
  result: TicketVerificationResult;
  /** The cancellation or void reason, when there is one. */
  reason: string;
  /** Present once the signature holds and the ticket is found. */
  ticket?: TicketCard;
}

/** A public JWK (RFC 8037): enough to verify, never to sign. */
export interface VerificationKey {
  kid: string;
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  alg: 'EdDSA';
}

export interface VerificationKeys {
  keys: VerificationKey[];
}

/**
 * What the QR carries (BR-38): exactly what a conductor checks, signed as a
 * whole. Only the National ID's last four digits, never the number itself.
 */
export interface TicketQrClaims {
  /** Identifies the ticket for the online check. */
  ticketNumber: string;
  trainNumber: number;
  /** Cairo date at the passenger's own boarding station (YYYY-MM-DD). */
  boardingDate: string;
  boardingStation: LocalizedName;
  alightingStation: LocalizedName;
  coachNumber: number;
  seatNumber: string;
  passengerName: string;
  nationalIdLast4: string;
}

/** The JWS `typ` of a ticket QR; a share token can never pass for one. */
export const TICKET_QR_TYPE = 'ticket-qr';
export const TICKET_SHARE_TYPE = 'ticket-share';
export const TICKET_SIGNING_ALGORITHM = 'EdDSA';
