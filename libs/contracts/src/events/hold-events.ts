import type { AllocationOutcome } from '../inventory/seat-allocation.dto.js';
import type { HoldState } from '../inventory/seat-hold.dto.js';
import type { EventEnvelope } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';

/**
 * One committed hold transition and one durable event id. Payloads carry no
 * National IDs, comparison tokens, masks, or passenger names.
 */
export interface HoldEventLegV1 {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  originPosition: number;
  destinationPosition: number;
  outcome: AllocationOutcome;
}

export type HoldEventReason = 'held' | 'released' | 'expired' | 'replaced' | 'extended';

export interface HoldLifecyclePayloadV1 {
  holdId: string;
  bookingKey: string;
  ownerId: string;
  aggregateVersion: number;
  state: HoldState;
  allocationOutcome: AllocationOutcome | null;
  legs: HoldEventLegV1[];
  expiresAt: string | null;
  extensionUsed: boolean;
  reason: HoldEventReason;
}

export const HOLD_HELD_EVENT_TYPE = EVENT_TYPES.holdHeld;
export const HOLD_RELEASED_EVENT_TYPE = EVENT_TYPES.holdReleased;
export const HOLD_EXPIRED_EVENT_TYPE = EVENT_TYPES.holdExpired;
export const HOLD_EXTENDED_EVENT_TYPE = EVENT_TYPES.holdExtended;

export const HOLD_EVENT_VERSION = 1;

export const HOLD_LIFECYCLE_PAYLOAD_KEYS = [
  'holdId',
  'bookingKey',
  'ownerId',
  'aggregateVersion',
  'state',
  'allocationOutcome',
  'legs',
  'expiresAt',
  'extensionUsed',
  'reason',
] as const satisfies readonly (keyof HoldLifecyclePayloadV1)[];

export type HoldHeldEvent = EventEnvelope<
  typeof HOLD_HELD_EVENT_TYPE,
  HoldLifecyclePayloadV1
>;
export type HoldReleasedEvent = EventEnvelope<
  typeof HOLD_RELEASED_EVENT_TYPE,
  HoldLifecyclePayloadV1
>;
export type HoldExpiredEvent = EventEnvelope<
  typeof HOLD_EXPIRED_EVENT_TYPE,
  HoldLifecyclePayloadV1
>;
export type HoldExtendedEvent = EventEnvelope<
  typeof HOLD_EXTENDED_EVENT_TYPE,
  HoldLifecyclePayloadV1
>;

export type HoldLifecycleEvent =
  | HoldHeldEvent
  | HoldReleasedEvent
  | HoldExpiredEvent
  | HoldExtendedEvent;
