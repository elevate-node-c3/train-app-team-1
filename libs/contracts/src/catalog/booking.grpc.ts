import type {
  LocalizedName,
  Money,
  TravelClass,
  TripEndpoint,
} from './catalog.dto.js';

export interface BookingLeg {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
}

export interface QuoteBookingRequest {
  legs: BookingLeg[];
  travelClassId: string;
}

/**
 * One leg as the passenger rides it, in search's vocabulary. The fare is for
 * one passenger; booking alone multiplies, adds the fee and totals (BR-31).
 */
export interface QuotedLeg {
  tripId: string;
  trainNumber: number;
  trainType: LocalizedName;
  departure: TripEndpoint;
  arrival: TripEndpoint;
  fare: Money;
}

export interface QuoteBookingResponse {
  travelClass: TravelClass;
  legs: QuotedLeg[];
}
