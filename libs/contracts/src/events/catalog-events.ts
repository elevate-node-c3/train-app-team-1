import type { EventEnvelope } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';
import type { LocalizedName } from '../catalog/catalog.dto.js';

export const TIMETABLE_PUBLISHED_EVENT_TYPE = EVENT_TYPES.timetablePublished;
export const TIMETABLE_PUBLISHED_VERSION = 1;

export const FARE_CHANGED_EVENT_TYPE = EVENT_TYPES.fareChanged;
export const FARE_CHANGED_VERSION = 1;

export const STATION_CHANGED_EVENT_TYPE = EVENT_TYPES.stationChanged;
export const STATION_CHANGED_VERSION = 1;

export const SEAT_AVAILABILITY_CHANGED_EVENT_TYPE =
  EVENT_TYPES.seatAvailabilityChanged;
export const SEAT_AVAILABILITY_CHANGED_VERSION = 1;

export interface FareChangedPayloadV1 {
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  trainId?: string;
  newAmountPiastres: number;
  effectiveFrom?: string;
}

export type FareChangedEvent = EventEnvelope<
  typeof FARE_CHANGED_EVENT_TYPE,
  FareChangedPayloadV1
>;

/** Stations are required: CAT-5 invalidates by them and cannot look them up. */
export interface TimetablePublishedPayloadV1 {
  timetableId: string;
  tripId?: string;
  originStationId: string;
  destinationStationId: string;
  intermediateStationIds?: string[];
  trainId: string;
  timetableVersion: number;
}

export type TimetablePublishedEvent = EventEnvelope<
  typeof TIMETABLE_PUBLISHED_EVENT_TYPE,
  TimetablePublishedPayloadV1
>;

export interface StationChangedPayloadV1 {
  stationId: string;
  action: 'created' | 'updated' | 'deactivated';
  nameAr?: string;
  nameEn?: string;
  cityId?: string;
  governorateId?: string;
  cityName?: LocalizedName;
  governorateName?: LocalizedName;
  altSpellings?: string[];
  isActive?: boolean;
  actorAccountId?: string;
}

export type StationChangedEvent = EventEnvelope<
  typeof STATION_CHANGED_EVENT_TYPE,
  StationChangedPayloadV1
>;

export interface SeatAvailabilityChangedPayloadV1 {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  availableSeats: number;
}

