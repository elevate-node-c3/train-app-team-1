import {
  AllocationOutcome,
  type SplitNoticePayload,
} from './seat-allocation.dto.js';

/**
 * Effective hold state as of Inventory's returned `serverNow`.
 *
 * `HELD` is the only state that owns seats. The other three are terminal
 * receipts: replaying their booking key never reallocates or reclaims seats.
 */
export type HoldState = 'HELD' | 'RELEASED' | 'EXPIRED' | 'CANCELLED' | 'SOLD';

/**
 * Identity's trip-scoped view of one traveller. The same canonical National ID
 * yields the same token for every account on that trip, and a different token
 * on every other trip. Inventory never sees the raw National ID.
 */
export interface HoldPassengerLegIdentityInput {
  /** The hold leg this token/version was pinned for. */
  tripId: string;
  /** Identity-issued trip-scoped HMAC token. */
  passengerToken: string;
  /** Immutable identity key version pinned for the trip. */
  passengerKeyVersion: number;
}

/**
 * One traveller in the hold. A round trip spans two dated trips, so Identity
 * supplies one token/version pair per leg; Inventory never reuses a token
 * across trips.
 */
export interface HoldPassengerInput {
  /** Booking's submitted passenger reference. Never a raw National ID. */
  passengerRef: string;
  /** Exactly one identity per hold leg, keyed by trip id. */
  identities: HoldPassengerLegIdentityInput[];
}

/** One dated trip and the half-open stop range the passenger occupies. */
export interface HoldLegInput {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
}

export interface CreateHoldRequest {
  /** Identity account UUID of the authenticated traveller. */
  ownerId: string;
  /** Immutable idempotency key owned by BOOK-2. */
  bookingKey: string;
  /** One or two legs. Duplicate trip ids are rejected. */
  legs: HoldLegInput[];
  /** One to four passengers. Duplicate passenger refs are rejected. */
  passengers: HoldPassengerInput[];
}

export interface GetHoldRequest {
  ownerId: string;
  bookingKey: string;
}

export interface ReleaseHoldRequest {
  ownerId: string;
  bookingKey: string;
}

export interface ExtendHoldRequest {
  ownerId: string;
  bookingKey: string;
}

export interface HoldLegResult {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  originPosition: number;
  destinationPosition: number;
  /** SEAT-2's outcome for this leg. */
  outcome: AllocationOutcome;
  splitNotice?: SplitNoticePayload;
}

/**
 * Durable allocation receipt for one passenger on one leg. This is a snapshot:
 * it stays available after release/expiry, but `HoldSnapshot.state` says
 * whether it still represents ownership.
 */
export interface HoldSeatAssignment {
  passengerRef: string;
  passengerKeyVersion: number;
  tripId: string;
  tripSeatId: string;
  travelClassId: string;
  coachNumber: number;
  seatNumber: string;
  rowNumber: number;
  label?: string;
  outcome: AllocationOutcome;
  originStationId: string;
  destinationStationId: string;
  originPosition: number;
  destinationPosition: number;
}

/**
 * Inventory's authoritative view of a hold at `serverNow`. `expiresAt` is the
 * promised expiry; it is null only for an unknown-key cancellation tombstone.
 */
export interface HoldSnapshot {
  holdId: string;
  bookingKey: string;
  ownerId: string;
  state: HoldState;
  /** Monotonic transition counter. */
  version: number;
  extensionUsed: boolean;
  expiresAt: string | null;
  /** Postgres `clock_timestamp()` sampled after lock waits. */
  serverNow: string;
  /**
   * Composition of every leg's SEAT-2 outcome: SPLIT if any leg split,
   * otherwise SAME_COACH if any leg needed a coach, otherwise SIDE_BY_SIDE.
   * Null when there are no allocations (a cancellation tombstone).
   */
  allocationOutcome: AllocationOutcome | null;
  legs: HoldLegResult[];
  assignments: HoldSeatAssignment[];
}

export type CreateHoldResponse = HoldSnapshot;
export type GetHoldResponse = HoldSnapshot;
export type ReleaseHoldResponse = HoldSnapshot;
export type ExtendHoldResponse = HoldSnapshot;

export interface SettleHoldRequest {
  ownerId: string;
  bookingKey: string;
}

/**
 * BR-36's branch: a live hold sells its exact seats, an expired-but-free hold
 * re-sells them, a taken hold reallocates within the same class, and a full
 * class refuses rather than occupying nothing.
 */
export type SettlementOutcome = 'SOLD' | 'REALLOCATED' | 'NO_SEATS';

export interface SettlementSnapshot {
  outcome: SettlementOutcome;
  holdId: string;
  legs: HoldLegResult[];
  assignments: HoldSeatAssignment[];
  /** Postgres `clock_timestamp()` sampled after lock waits. */
  serverNow: string;
}

/** Compose per-leg SEAT-2 outcomes into one hold-level outcome. */
export function composeAllocationOutcome(
  outcomes: readonly AllocationOutcome[],
): AllocationOutcome | null {
  if (outcomes.length === 0) return null;
  if (outcomes.includes(AllocationOutcome.SPLIT)) {
    return AllocationOutcome.SPLIT;
  }
  if (outcomes.includes(AllocationOutcome.SAME_COACH)) {
    return AllocationOutcome.SAME_COACH;
  }
  return AllocationOutcome.SIDE_BY_SIDE;
}
