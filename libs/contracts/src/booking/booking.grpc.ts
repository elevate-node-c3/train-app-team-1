import { getProtoPath } from '../proto-path.js';
import type { BookingLeg } from '../catalog/booking.grpc.js';
import type {
  LocalizedName,
  TravelClass,
  TripEndpoint,
} from '../catalog/catalog.dto.js';
import type {
  AllocationOutcome,
  SplitNoticePayload,
} from '../inventory/seat-allocation.dto.js';

export const BOOKING_PACKAGE_NAME = 'train.booking.v1';
export const BOOKING_SERVICE_NAME = 'BookingService';

export function getBookingProtoPath(): string {
  return getProtoPath('booking.proto');
}

export interface SubmitBookingRequest {
  idempotencyKey: string;
  legs: BookingLeg[];
  travelClassId: string;
  passengerIds: string[];
}

export interface ContinueBookingRequest {
  bookingReference: string;
}

export interface ContinueToPaymentRequest {
  bookingReference: string;
  savedCardId?: string;
}

/** A passenger as reviewed at the hold; the National ID never leaves booking. */
export interface BookedPassenger {
  passengerId: string;
  fullName: string;
  coachNumber: number;
  seatNumber: string;
  seatLabel: string;
  farePiastres: number;
}

export interface BookedLeg {
  tripId: string;
  trainNumber: number;
  trainType: LocalizedName;
  departure: TripEndpoint;
  arrival: TripEndpoint;
  farePiastres: number;
  allocationOutcome: AllocationOutcome | '';
  splitNotice?: SplitNoticePayload;
  passengers: BookedPassenger[];
}

/** Issued only once the booking reaches 'confirmed'. */
export interface Ticket {
  ticketNumber: string;
  passengerRef: string;
  tripId: string;
  coachNumber: number;
  seatNumber: string;
}

/** Everything the Review Tickets step needs, in one response. */
export interface BookingResponse {
  bookingReference: string;
  state: string;
  totalPiastres: number;
  currency: string;
  holdExpiresAt: string;
  paymentReference: string;
  /** Only exposed to the owner while awaiting SDK confirmation; never logged. */
  clientSecret?: string;
  serverTime: string;
  travelClass?: TravelClass;
  legs: BookedLeg[];
  fareTotalPiastres: number;
  bookingFeePiastres: number;
  bookingFeePercent: number;
  termsAcceptedAt: string;
  tickets: Ticket[];
  /** A late payment forced a reallocation; the traveller's seats moved. */
  seatsChanged: boolean;
}
