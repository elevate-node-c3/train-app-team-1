import type { EventLanguage } from '../events/event-envelope.js';

/**
 * The shapes carried by `train.catalog.v1`. Responses are interfaces here, as
 * the house rule has it; the gateway's request DTO is a class-validator class
 * in `apps/gateway/src/modules/catalog/dto/`.
 *
 * Field names match catalog.proto exactly, and `catalog.grpc.spec.ts` fails if
 * the two drift apart in either direction.
 */

/** ISO 4217. The `fare` column stores piastres with no currency of its own. */
export const FARE_CURRENCY = 'EGP';

export type SearchEmptyReason =
  | 'SEARCH_EMPTY_REASON_UNSPECIFIED'
  | 'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED'
  | 'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE'
  | 'SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE';

export type SearchSort =
  | 'SEARCH_SORT_UNSPECIFIED'
  | 'SEARCH_SORT_DEPARTURE_ASC'
  | 'SEARCH_SORT_DURATION_ASC'
  | 'SEARCH_SORT_FARE_ASC'
  | 'SEARCH_SORT_ARRIVAL_ASC';

/**
 * A Cairo wall-clock moment. `localTime` is printed verbatim by the client;
 * nothing downstream should re-format it through a platform date formatter,
 * which would shift the hour for a client in another zone.
 */
export interface CivilDateTime {
  localDate: string;
  localTime: string;
  utcOffset: string;
  iso: string;
  timeZone: string;
}

export interface LocalizedName {
  en: string;
  ar: string;
}

export interface Money {
  /** Integer piastres, excluding the booking fee (BR-19). */
  amountMinor: number;
  currency: string;
}

export interface SearchFilters {
  trainTypeIds?: string[];
  departAfterMinutes?: number;
  departBeforeMinutes?: number;
  maxFareMinor?: number;
  excludeSoldOut?: boolean;
}

export interface SearchOneWayTripsRequest {
  originStationId: string;
  destinationStationId: string;
  /** 'YYYY-MM-DD', a Cairo civil date. */
  departureDate: string;
  travelClassId: string;
  /** The caller's declared preference; absent means the platform fallback. */
  language?: EventLanguage | '';
  /** Absent means "any train"; BR-18's optional narrowing filter. */
  trainNumber?: number;
  /** Unset today. TA-18 implements these server-side without a wire change. */
  sort?: SearchSort;
  filters?: SearchFilters;
}

export interface BookingWindow {
  firstBookableDate: string;
  lastBookableDate: string;
  totalDays: number;
}

export interface DateStripDay {
  date: string;
  selected: boolean;
  isToday: boolean;
  bookable: boolean;
}

export interface TravelClass {
  id: string;
  name: LocalizedName;
}

export interface TripEndpoint {
  stationId: string;
  name: LocalizedName;
  at: CivilDateTime;
}

export interface TripResult {
  tripId: string;
  trainNumber: number;
  trainType: LocalizedName;
  travelClass: TravelClass;
  /** The passenger's origin, not the train's first station. */
  departure: TripEndpoint;
  arrival: TripEndpoint;
  /** Computed from instants, so midnight and DST crossings are irrelevant. */
  durationMinutes: number;
  /** Excludes both endpoints. */
  intermediateStops: number;
  availableSeats: number;
  soldOut: boolean;
  fare: Money;
}

export interface EmptyResult {
  reason: SearchEmptyReason;
  /** Values for the gateway's localized sentence, e.g. `lastBookableDate`. */
  params: Record<string, string>;
}

export interface SearchOneWayTripsResponse {
  dateStrip: DateStripDay[];
  trips: TripResult[];
  /** Set if and only if `trips` is empty. */
  emptyResult?: EmptyResult;
  bookingWindow: BookingWindow;
  evaluatedAt: CivilDateTime;
}
