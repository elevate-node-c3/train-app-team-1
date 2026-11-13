import type { EventLanguage } from '../events/event-envelope.js';

/**
 * Shared wire interfaces; gateway classes own HTTP validation.
 * Tests keep fields in sync with catalog.proto.
 */

/** ISO 4217 currency; EGP fares use piastres. */
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

/** Print Cairo localTime unchanged so the user's timezone cannot shift it. */
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
  /** Whole piastres, excluding booking fees. */
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
  /** Count this train type before applying filters. */
  tripCount: number;
}

/** Available choices from the unfiltered day. */
export interface FilterOptions {
  trainTypes: TrainTypeOption[];
  /** Cheapest fare before booking fees. */
  minFareMinor: number;
  /** Most expensive fare before booking fees. */
  maxFareMinor: number;
}

export interface SearchOneWayTripsRequest {
  originStationId: string;
  destinationStationId: string;
  /** YYYY-MM-DD in Cairo. */
  departureDate: string;
  travelClassId: string;
  /** Optional preference; defaults to the platform language. */
  language?: EventLanguage | '';
  /** Missing means any train. */
  trainNumber?: number;
  /**
   * Validate and record the round trip before the outbound choice.
   * Outbound results stay unchanged.
   */
  returnDate?: string;
  /** Filter the cached day in memory, without another database query. */
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
  /** Passenger's boarding station, not the train's origin. */
  departure: TripEndpoint;
  arrival: TripEndpoint;
  /** Compute from timestamps so midnight and DST do not affect duration. */
  durationMinutes: number;
  /** Excludes both endpoints. */
  intermediateStops: number;
  availableSeats: number;
  soldOut: boolean;
  fare: Money;
}

export interface EmptyResult {
  reason: SearchEmptyReason;
  /** Values inserted into the gateway's localized message. */
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
 * Catalog reads the outbound arrival; callers cannot supply one.
 * Train numbers narrow only the outbound leg.
 */
export interface SearchReturnTripsRequest {
  outboundTripId: string;
  outboundOriginStationId: string;
  outboundDestinationStationId: string;
  /** YYYY-MM-DD in Cairo. */
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

export interface ListStationsRequest {
  /** Resolved from the gateway's Accept-Language header. */
  language: string;
  query?: string;
}

export interface StationItem {
  id: string;
  name: string;
  cityName: string;
}

export interface GovernorateGroup {
  id: string;
  name: string;
  stations: StationItem[];
}

export interface ListStationsResponse {
  governorates: GovernorateGroup[];
}

export interface StationDetails {
  id: string;
  cityId: string;
  governorateId: string;
  name: LocalizedName;
  cityName: LocalizedName;
  governorateName: LocalizedName;
  altSpellings: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StationResponse {
  station: StationDetails;
}

export interface StationIdRequest {
  stationId: string;
}

export interface CreateStationRequest {
  cityId: string;
  nameAr: string;
  nameEn: string;
  altSpellings?: string[];
  isActive?: boolean;
}

export interface StationAliases {
  values: string[];
}

export interface UpdateStationRequest {
  stationId: string;
  cityId?: string;
  nameAr?: string;
  nameEn?: string;
  /** An absent wrapper leaves aliases unchanged; empty values clear them. */
  aliases?: StationAliases;
  isActive?: boolean;
}
