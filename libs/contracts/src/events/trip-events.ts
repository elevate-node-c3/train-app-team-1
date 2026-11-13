import type { EventEnvelope } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';

export interface TripPublishedStopV1 {
  stationId: string;
  position: number;
  arrivalAt: string | null;
  departureAt: string | null;
}

export interface TripPublishedCoachV1 {
  position: number;
  coachNumber: number;
  travelClass: {
    id: string;
    nameEn: string;
    nameAr: string;
  };
  coachLayout: {
    id: string;
    layoutName: string;
    /** Seats on the same side of a row are adjacent. */
    rows: {
      rowNumber: number;
      leftSeats: string[];
      rightSeats: string[];
    }[];
  };
}

export interface TripPublishedTrainTypeV1 {
  id: string;
  nameEn: string;
  nameAr: string;
}

export interface TripPublishedPayloadV1 {
  tripId: string;
  trainId: string;
  trainNumber: number;
  trainType: TripPublishedTrainTypeV1;
  serviceDate: string;
  timetableVersion: number;
  capacity: number;
  stops: TripPublishedStopV1[];
  coaches: TripPublishedCoachV1[];
}

export const TRIP_PUBLISHED_EVENT_TYPE = EVENT_TYPES.tripPublished;

export const TRIP_PUBLISHED_VERSION = 1;

export const TRIP_PUBLISHED_PAYLOAD_KEYS = [
  'tripId',
  'trainId',
  'trainNumber',
  'trainType',
  'serviceDate',
  'timetableVersion',
  'capacity',
  'stops',
  'coaches',
] as const satisfies readonly (keyof TripPublishedPayloadV1)[];

export type TripPublishedEvent = EventEnvelope<
  typeof TRIP_PUBLISHED_EVENT_TYPE,
  TripPublishedPayloadV1
>;

export interface TripWithdrawnPayloadV1 {
  tripId: string;
}

export const TRIP_WITHDRAWN_EVENT_TYPE = EVENT_TYPES.tripWithdrawn;

export const TRIP_WITHDRAWN_VERSION = 1;

export const TRIP_WITHDRAWN_PAYLOAD_KEYS = [
  'tripId',
] as const satisfies readonly (keyof TripWithdrawnPayloadV1)[];

export type TripWithdrawnEvent = EventEnvelope<
  typeof TRIP_WITHDRAWN_EVENT_TYPE,
  TripWithdrawnPayloadV1
>;
