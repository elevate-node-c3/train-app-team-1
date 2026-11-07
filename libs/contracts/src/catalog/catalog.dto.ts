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
  | 'SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE'
  | 'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL'
  | 'SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL';

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

export interface TrainTypeOption {
  id: string;
  name: LocalizedName;
  /** How many of the day's unfiltered trips are this type. */
  tripCount: number;
}

/** The choices the day offers, computed before the request's filters apply. */
export interface FilterOptions {
  trainTypes: TrainTypeOption[];
  /** Cheapest priced trip of the day, excluding the booking fee. */
  minFareMinor: number;
  /** Most expensive priced trip of the day, excluding the booking fee. */
  maxFareMinor: number;
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
  /**
   * A round trip's return date, carried by the outbound search.
   *
   * Does not change the outbound list. It is what lets BR-20 refuse an
   * impossible return date before the traveller picks an outbound trip, and
   * what tells catalog the search is a round trip rather than a one-way.
   */
  returnDate?: string;
  /** Applied in memory over the day's cached results, never as a new query. */
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
  filterOptions?: FilterOptions;
}

/**
 * The return leg. There is deliberately no arrival time: BR-20 makes the
 * server read the outbound trip's arrival, and no train number, because that
 * narrowed the outbound leg only.
 */
export interface SearchReturnTripsRequest {
  outboundTripId: string;
  outboundOriginStationId: string;
  outboundDestinationStationId: string;
  /** 'YYYY-MM-DD', a Cairo civil date. */
  returnDate: string;
  travelClassId: string;
  language?: EventLanguage | '';
  sort?: SearchSort;
  filters?: SearchFilters;
}

export interface SearchReturnTripsResponse {
  trips: TripResult[];
  /** Set if and only if `trips` is empty. */
  emptyResult?: EmptyResult;
  evaluatedAt: CivilDateTime;
  filterOptions?: FilterOptions;
}

export interface GetTripStopsRequest {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
  language?: EventLanguage | '';
}

export interface TripStop {
  stationId: string;
  name: LocalizedName;
  /** Absent at the first stop. */
  arrival?: CivilDateTime;
  /** Absent at the last stop. */
  departure?: CivilDateTime;
  boarding: boolean;
  alighting: boolean;
}

export interface TripStopsResponse {
  /** Boarding, every stop between, and alighting, in travel order. */
  stops: TripStop[];
}

export type RecentSearchKind =
  | 'RECENT_SEARCH_KIND_UNSPECIFIED'
  | 'RECENT_SEARCH_KIND_ONE_WAY'
  | 'RECENT_SEARCH_KIND_ROUND_TRIP';

export interface RecentSearchStation {
  id: string;
  name: LocalizedName;
}

export interface RecentSearch {
  origin: RecentSearchStation;
  destination: RecentSearchStation;
  travelClass: TravelClass;
  kind: RecentSearchKind;
  /** Absent when the traveller did not narrow by train. */
  trainNumber?: number;
  /** Absent when too old to repeat; both dates travel together. */
  departureDate?: string;
  returnDate?: string;
  searchedAt: CivilDateTime;
}

export interface ListRecentSearchesRequest {
  language?: EventLanguage | '';
}

export interface ListRecentSearchesResponse {
  recentSearches: RecentSearch[];
}
