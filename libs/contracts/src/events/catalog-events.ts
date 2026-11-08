import { EVENT_TYPES } from './event-types.js';

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

export interface TimetablePublishedPayloadV1 {
  timetableId: string;
  tripId?: string;
  originStationId: string;
  destinationStationId: string;
  intermediateStationIds?: string[];
}

export interface StationChangedPayloadV1 {
  stationId: string;
  action: 'created' | 'updated' | 'deactivated';
}

export interface SeatAvailabilityChangedPayloadV1 {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  availableSeats: number;
}
