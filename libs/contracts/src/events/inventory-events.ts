import type { EventEnvelope } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';

export interface TripSeatsCreatedSeatCountV1 {
  travelClassId: string;
  seatCount: number;
}

export interface TripSeatsCreatedPayloadV1 {
  tripId: string;
  serviceDate: string;
  timetableVersion: number;
  seatCountByClass: TripSeatsCreatedSeatCountV1[];
}

export const TRIP_SEATS_CREATED_EVENT_TYPE = EVENT_TYPES.tripSeatsCreated;

export const TRIP_SEATS_CREATED_VERSION = 1;

export const TRIP_SEATS_CREATED_PAYLOAD_KEYS = [
  'tripId',
  'serviceDate',
  'timetableVersion',
  'seatCountByClass',
] as const satisfies readonly (keyof TripSeatsCreatedPayloadV1)[];

export type TripSeatsCreatedEvent = EventEnvelope<
  typeof TRIP_SEATS_CREATED_EVENT_TYPE,
  TripSeatsCreatedPayloadV1
>;

export interface TripPublicationRefusedPayloadV1 {
  tripId: string;
  timetableVersion: number;
  reason: string;
  occupiedSeatNumbers: string[];
  occupiedStationIds: string[];
}

export const TRIP_PUBLICATION_REFUSED_EVENT_TYPE =
  EVENT_TYPES.tripPublicationRefused;

export const TRIP_PUBLICATION_REFUSED_VERSION = 1;

export const TRIP_PUBLICATION_REFUSED_PAYLOAD_KEYS = [
  'tripId',
  'timetableVersion',
  'reason',
  'occupiedSeatNumbers',
  'occupiedStationIds',
] as const satisfies readonly (keyof TripPublicationRefusedPayloadV1)[];

export type TripPublicationRefusedEvent = EventEnvelope<
  typeof TRIP_PUBLICATION_REFUSED_EVENT_TYPE,
  TripPublicationRefusedPayloadV1
>;
