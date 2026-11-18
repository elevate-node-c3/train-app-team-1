import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import {
  AllocationOutcome,
  SEATS_SPLIT_NOTICE,
  type HoldLegInput,
  type HoldLegResult,
  type HoldEventLegV1,
  type HoldLifecyclePayloadV1,
  type HoldPassengerInput,
  type HoldSeatAssignment,
  type HoldSnapshot,
  type HoldState,
  composeAllocationOutcome,
} from '@app/contracts';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { HoldCoreError } from './hold-core.errors.js';
import type { AllocatableSeat } from '../seat-allocation/seat-allocator.types.js';
import { toInt4Range, type Segment } from '../seats/segment.js';
import { ErrorCode } from '@app/contracts';

export type DbHoldState = 'held' | 'released' | 'expired' | 'cancelled';

export interface HoldRow {
  id: string;
  bookingKey: string;
  ownerId: string;
  requestFingerprint: string;
  state: DbHoldState;
  version: number;
  extensionUsed: boolean;
  expiresAt: Date | null;
  releasedAt: Date | null;
}

export interface LegFacts {
  leg: HoldLegInput;
  originPosition: number;
  destinationPosition: number;
  originDepartureAt: Date;
  segment: Segment;
}

export interface LegLayout {
  /** Every seat of the leg's trip and class, occupied or not. */
  seats: AllocatableSeat[];
  /** Seats blocked over the leg's segment. */
  occupiedSeatIds: Set<string>;
}

export interface PersistedLeg {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  originPosition: number;
  destinationPosition: number;
  segment: Segment;
  outcome: AllocationOutcome;
}

export interface PersistedAssignment {
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
  segment: Segment;
}

export interface NewHold {
  id: string;
  bookingKey: string;
  ownerId: string;
  fingerprint: string;
  expiresAt: Date;
  now: Date;
  passengers: HoldPassengerInput[];
  legs: PersistedLeg[];
  assignments: PersistedAssignment[];
}

interface HoldDbRow {
  id: string;
  bookingKey: string;
  ownerId: string;
  requestFingerprint: string;
  state: DbHoldState;
  version: number;
  extensionUsed: boolean;
  expiresAt: Date | null;
  releasedAt: Date | null;
}

interface NowRow {
  now: Date;
}

interface LegFactRow {
  status: string;
  originPosition: number;
  destinationPosition: number;
  originDepartureAt: Date | null;
}

interface SeatDbRow {
  seatId: string;
  coachNumber: number;
  seatNumber: string;
  rowNumber: number;
  side: 'left' | 'right';
  seatIndexInSide: number;
}

interface LegViewRow {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  originPosition: number;
  destinationPosition: number;
  outcome: AllocationOutcome;
}

interface AssignmentViewRow {
  passengerRef: string;
  passengerKeyVersion: number;
  tripId: string;
  tripSeatId: string;
  travelClassId: string;
  coachNumber: number;
  seatNumber: string;
  rowNumber: number;
  label: string | null;
  outcome: AllocationOutcome;
  originStationId: string;
  destinationStationId: string;
  originPosition: number;
  destinationPosition: number;
}

interface ExpiredHoldRow {
  holdId: string;
  bookingKey: string;
  ownerId: string;
  version: number;
  expiresAt: Date;
  extensionUsed: boolean;
  legs: HoldEventLegV1[];
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function managerOf(ctx: TransactionContext): EntityManager {
  return entityManagerOf(ctx);
}

/**
 * Every method takes the caller's TransactionContext and unwraps it with
 * entityManagerOf. There is deliberately no DataSource fallback: a hold must
 * never read or write outside the transaction that owns its locks.
 */
@Injectable()
export class HoldCoreRepository {
  /** Claim persisted deadlines; another instance skips our transaction locks. */
  async lockDueHolds(
    ctx: TransactionContext,
    limit: number,
  ): Promise<HoldRow[]> {
    return managerOf(ctx).query(
      `SELECT id,
              booking_key AS "bookingKey",
              owner_id AS "ownerId",
              request_fingerprint AS "requestFingerprint",
              state, version,
              extension_used AS "extensionUsed",
              expires_at AS "expiresAt",
              released_at AS "releasedAt"
       FROM seat_hold_group
       WHERE state = 'held' AND expires_at <= clock_timestamp()
       ORDER BY expires_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
  }

  async tripIdsForHolds(
    ctx: TransactionContext,
    holdIds: readonly string[],
  ): Promise<string[]> {
    if (holdIds.length === 0) return [];
    const rows: { tripId: string }[] = await managerOf(ctx).query(
      `SELECT DISTINCT trip_id AS "tripId"
       FROM seat_hold_leg
       WHERE hold_id = ANY($1::uuid[])
       ORDER BY trip_id`,
      [holdIds],
    );
    return rows.map((row) => row.tripId);
  }

  /** Transition, release all legs, and retain the receipt for event publication. */
  async expireHolds(
    ctx: TransactionContext,
    holdIds: readonly string[],
    now: Date,
  ): Promise<HoldLifecyclePayloadV1[]> {
    if (holdIds.length === 0) return [];
    const manager = managerOf(ctx);

    // SELECT over RETURNING keeps the driver's result shape consistent.
    const rows: ExpiredHoldRow[] = await manager.query(
      `WITH expired AS (
         UPDATE seat_hold_group
         SET state = 'expired', version = version + 1,
             released_at = $2, updated_at = $2
         WHERE id = ANY($1::uuid[])
           AND state = 'held' AND expires_at <= $2
         RETURNING id, booking_key, owner_id, version, expires_at, extension_used
       )
       SELECT e.id AS "holdId", e.booking_key AS "bookingKey",
              e.owner_id AS "ownerId", e.version,
              e.expires_at AS "expiresAt", e.extension_used AS "extensionUsed",
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'tripId', l.trip_id, 'travelClassId', l.travel_class_id,
                  'originStationId', l.origin_station_id,
                  'destinationStationId', l.destination_station_id,
                  'originPosition', l.origin_position,
                  'destinationPosition', l.destination_position,
                  'outcome', l.outcome
                ) ORDER BY l.trip_id)
                FROM seat_hold_leg l WHERE l.hold_id = e.id
              ), '[]'::jsonb) AS legs
       FROM expired e
       ORDER BY e.id`,
      [holdIds, now],
    );

    if (rows.length === 0) return [];
    await manager.query(
      `UPDATE seat_occupation
       SET released_at = $2, updated_at = $2
       WHERE hold_id = ANY($1::uuid[])
         AND state = 'held' AND released_at IS NULL`,
      [rows.map((row) => row.holdId), now],
    );

    return rows.map((row) => ({
      holdId: row.holdId,
      bookingKey: row.bookingKey,
      ownerId: row.ownerId,
      aggregateVersion: Number(row.version),
      state: 'EXPIRED',
      allocationOutcome: composeAllocationOutcome(
        row.legs.map((leg) => leg.outcome),
      ),
      legs: row.legs,
      expiresAt: asDate(row.expiresAt).toISOString(),
      extensionUsed: row.extensionUsed,
      reason: 'expired',
    }));
  }

  async lockHoldByKey(
    ctx: TransactionContext,
    bookingKey: string,
  ): Promise<HoldRow | null> {
    const rows = (await managerOf(ctx).query(
      `SELECT id,
              booking_key AS "bookingKey",
              owner_id AS "ownerId",
              request_fingerprint AS "requestFingerprint",
              state,
              version,
              extension_used AS "extensionUsed",
              expires_at AS "expiresAt",
              released_at AS "releasedAt"
       FROM seat_hold_group
       WHERE booking_key = $1
       FOR UPDATE`,
      [bookingKey],
    )) as HoldDbRow[];

    return rows[0] ?? null;
  }

  /**
   * Serializes creates for one traveller before the owner-active check. The
   * partial unique owner index alone is too late: a second session can pass
   * the owner check, wait on the trip lock, and then misread the winner's
   * committed occupation as a passenger-overlap conflict.
   */
  async lockOwnerGuard(
    ctx: TransactionContext,
    ownerId: string,
  ): Promise<void> {
    const manager = managerOf(ctx);

    await manager.query(
      `INSERT INTO seat_hold_owner_guard (owner_id, created_at)
       VALUES ($1, clock_timestamp())
       ON CONFLICT (owner_id) DO NOTHING`,
      [ownerId],
    );

    await manager.query(
      `SELECT owner_id
       FROM seat_hold_owner_guard
       WHERE owner_id = $1
       FOR UPDATE`,
      [ownerId],
    );
  }

  async lockActiveHoldByOwner(
    ctx: TransactionContext,
    ownerId: string,
  ): Promise<HoldRow | null> {
    const rows = (await managerOf(ctx).query(
      `SELECT id,
              booking_key AS "bookingKey",
              owner_id AS "ownerId",
              request_fingerprint AS "requestFingerprint",
              state,
              version,
              extension_used AS "extensionUsed",
              expires_at AS "expiresAt",
              released_at AS "releasedAt"
       FROM seat_hold_group
       WHERE owner_id = $1 AND state = 'held'
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE`,
      [ownerId],
    )) as HoldDbRow[];

    return rows[0] ?? null;
  }

  async legTripIds(ctx: TransactionContext, holdId: string): Promise<string[]> {
    const rows = (await managerOf(ctx).query(
      `SELECT trip_id AS "tripId"
       FROM seat_hold_leg
       WHERE hold_id = $1
       ORDER BY trip_id`,
      [holdId],
    )) as { tripId: string }[];

    return rows.map((row) => row.tripId);
  }

  async loadLegInputs(
    ctx: TransactionContext,
    holdId: string,
  ): Promise<HoldLegInput[]> {
    return (await managerOf(ctx).query(
      `SELECT trip_id AS "tripId",
              travel_class_id AS "travelClassId",
              origin_station_id AS "originStationId",
              destination_station_id AS "destinationStationId"
       FROM seat_hold_leg
       WHERE hold_id = $1
       ORDER BY trip_id`,
      [holdId],
    )) as HoldLegInput[];
  }

  /**
   * Globally sorted trip locks: every hold path locks the same union in UUID
   * order, so two transactions cannot form a lock cycle.
   */
  async lockTrips(
    ctx: TransactionContext,
    tripIds: readonly string[],
  ): Promise<void> {
    const wanted = [...new Set(tripIds)].sort();
    if (wanted.length === 0) return;

    const rows = (await managerOf(ctx).query(
      `SELECT id
       FROM inventory_trip
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [wanted],
    )) as { id: string }[];

    if (rows.length !== wanted.length) {
      throw new HoldCoreError(
        ErrorCode.RESOURCE_NOT_FOUND,
        'One or more trips do not exist.',
      );
    }
  }

  /** Postgres clock, sampled by the caller after all lock waits. */
  async sampleNow(ctx: TransactionContext): Promise<Date> {
    const rows = (await managerOf(ctx).query(
      `SELECT clock_timestamp() AS "now"`,
    )) as NowRow[];

    return asDate(rows[0].now);
  }

  /**
   * Physical reclamation only: expired held rows stop blocking seats and
   * passenger tokens immediately. The hold head and its terminal event are
   * left to the owner/expiry path, so partial cleanup never fabricates an
   * expiry event.
   */
  async reclaimExpiredOccupations(
    ctx: TransactionContext,
    tripIds: readonly string[],
    now: Date,
  ): Promise<void> {
    if (tripIds.length === 0) return;

    await managerOf(ctx).query(
      `UPDATE seat_occupation
       SET released_at = $2, updated_at = $2
       WHERE trip_id = ANY($1::uuid[])
         AND state = 'held'
         AND released_at IS NULL
         AND hold_expires_at <= $2`,
      [[...new Set(tripIds)], now],
    );
  }

  async resolveLegFacts(
    ctx: TransactionContext,
    legs: readonly HoldLegInput[],
  ): Promise<LegFacts[]> {
    const facts: LegFacts[] = [];

    for (const leg of legs) {
      const rows = (await managerOf(ctx).query(
        `SELECT t.status,
                o.position AS "originPosition",
                d.position AS "destinationPosition",
                o.departure_at AS "originDepartureAt"
         FROM inventory_trip t
         JOIN trip_stop o
           ON o.trip_id = t.id AND o.station_id = $2
         JOIN trip_stop d
           ON d.trip_id = t.id AND d.station_id = $3
         WHERE t.id = $1`,
        [leg.tripId, leg.originStationId, leg.destinationStationId],
      )) as LegFactRow[];

      const row = rows[0];
      if (!row) {
        throw new HoldCoreError(
          ErrorCode.RESOURCE_NOT_FOUND,
          'The trip or one of its stops does not exist.',
        );
      }

      if (row.status !== 'on_sale') {
        throw new HoldCoreError(
          ErrorCode.SALES_CLOSED,
          'This trip is not on sale.',
        );
      }

      if (row.originDepartureAt === null) {
        throw new HoldCoreError(
          ErrorCode.SALES_CLOSED,
          'The boarding stop has no departure time.',
        );
      }

      if (row.originPosition >= row.destinationPosition) {
        throw new HoldCoreError(
          ErrorCode.VALIDATION_ERROR,
          'The destination must come after the origin on this trip.',
        );
      }

      facts.push({
        leg,
        originPosition: Number(row.originPosition),
        destinationPosition: Number(row.destinationPosition),
        originDepartureAt: asDate(row.originDepartureAt),
        segment: {
          from: Number(row.originPosition),
          to: Number(row.destinationPosition),
        },
      });
    }

    return facts;
  }

  /**
   * National-ID travel overlap is checked before seat shortage so the caller
   * gets the specific passenger refusal, not a misleading seat count.
   */
  async assertPassengersClear(
    ctx: TransactionContext,
    passengers: readonly HoldPassengerInput[],
    facts: readonly LegFacts[],
    now: Date,
  ): Promise<void> {
    for (const fact of facts) {
      for (const passenger of passengers) {
        const identity = passenger.identities.find(
          (candidate) => candidate.tripId === fact.leg.tripId,
        );
        if (!identity) {
          throw new HoldCoreError(
            ErrorCode.INTERNAL_SERVER_ERROR,
            'A passenger is missing an identity for one hold leg.',
          );
        }

        const rows = (await managerOf(ctx).query(
          `SELECT 1
           FROM seat_occupation o
           WHERE o.passenger_token = $1
             AND o.trip_id = $2
             AND o.released_at IS NULL
             AND (o.state = 'sold' OR o.hold_expires_at > $3)
             AND o.segment && $4::int4range
           LIMIT 1`,
          [
            identity.passengerToken,
            fact.leg.tripId,
            now,
            toInt4Range(fact.segment),
          ],
        )) as unknown[];

        if (rows.length > 0) {
          throw new HoldCoreError(
            ErrorCode.PASSENGER_OVERLAP,
            'A passenger already has an overlapping claim on this trip.',
            undefined,
            passenger.passengerRef,
          );
        }
      }
    }
  }

  /**
   * Reads the leg's seats in the shape allocateGroupSeats consumes. Geometry
   * comes only from trip_seat/trip_coach; no client layout is accepted.
   */
  async layoutFor(
    ctx: TransactionContext,
    fact: LegFacts,
    now: Date,
  ): Promise<LegLayout> {
    const rows = (await managerOf(ctx).query(
      `SELECT ts.id AS "seatId",
              tc.coach_number AS "coachNumber",
              ts.seat_number AS "seatNumber",
              ts.row_number AS "rowNumber",
              ts.side,
              ts.seat_index_in_side AS "seatIndexInSide"
       FROM trip_seat ts
       JOIN trip_coach tc ON tc.id = ts.trip_coach_id
       WHERE ts.trip_id = $1 AND ts.travel_class_id = $2`,
      [fact.leg.tripId, fact.leg.travelClassId],
    )) as SeatDbRow[];

    // Postgres returns integers as strings over some drivers; the allocator
    // compares row and seat indices numerically.
    const seats: AllocatableSeat[] = rows.map((row) => ({
      seatId: row.seatId,
      coachNumber: Number(row.coachNumber),
      seatNumber: row.seatNumber,
      rowNumber: Number(row.rowNumber),
      side: row.side,
      seatIndexInSide: Number(row.seatIndexInSide),
    }));

    // An expired-but-unreleased hold still blocks a write, so the occupancy
    // predicate here matches the exclusion constraint rather than now() alone.
    const occupiedRows = (await managerOf(ctx).query(
      `SELECT DISTINCT o.trip_seat_id AS "seatId"
       FROM seat_occupation o
       JOIN trip_seat ts ON ts.id = o.trip_seat_id
       WHERE ts.trip_id = $1
         AND ts.travel_class_id = $2
         AND o.released_at IS NULL
         AND (o.state = 'sold' OR o.hold_expires_at > $3)
         AND o.segment && $4::int4range`,
      [fact.leg.tripId, fact.leg.travelClassId, now, toInt4Range(fact.segment)],
    )) as { seatId: string }[];

    return {
      seats,
      occupiedSeatIds: new Set(occupiedRows.map((row) => row.seatId)),
    };
  }

  async insertHold(ctx: TransactionContext, hold: NewHold): Promise<void> {
    const manager = managerOf(ctx);

    await manager.query(
      `INSERT INTO seat_hold_group
         (id, booking_key, owner_id, request_fingerprint, state, version,
          extension_used, expires_at, released_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'held', 1, false, $5, NULL, $6, $6)`,
      [
        hold.id,
        hold.bookingKey,
        hold.ownerId,
        hold.fingerprint,
        hold.expiresAt,
        hold.now,
      ],
    );

    for (const passenger of hold.passengers) {
      for (const leg of hold.legs) {
        const identity = passenger.identities.find(
          (candidate) => candidate.tripId === leg.tripId,
        );
        if (!identity) {
          throw new HoldCoreError(
            ErrorCode.INTERNAL_SERVER_ERROR,
            'A passenger is missing an identity for one hold leg.',
          );
        }

        await manager.query(
          `INSERT INTO seat_hold_passenger
             (id, hold_id, trip_id, passenger_ref, passenger_token,
              passenger_key_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            hold.id,
            leg.tripId,
            passenger.passengerRef,
            identity.passengerToken,
            identity.passengerKeyVersion,
            hold.now,
          ],
        );
      }
    }

    for (const leg of hold.legs) {
      await manager.query(
        `INSERT INTO seat_hold_leg
           (id, hold_id, trip_id, travel_class_id, origin_station_id,
            destination_station_id, origin_position, destination_position,
            segment, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::int4range, $10, $11)`,
        [
          randomUUID(),
          hold.id,
          leg.tripId,
          leg.travelClassId,
          leg.originStationId,
          leg.destinationStationId,
          leg.originPosition,
          leg.destinationPosition,
          toInt4Range(leg.segment),
          leg.outcome,
          hold.now,
        ],
      );
    }

    for (const assignment of hold.assignments) {
      await manager.query(
        `INSERT INTO seat_hold_assignment
           (id, hold_id, passenger_ref, passenger_key_version, trip_id,
            trip_seat_id, travel_class_id, coach_number, seat_number,
            row_number, label, outcome, origin_station_id,
            destination_station_id, origin_position, destination_position,
            segment, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17::int4range, $18)`,
        [
          randomUUID(),
          hold.id,
          assignment.passengerRef,
          assignment.passengerKeyVersion,
          assignment.tripId,
          assignment.tripSeatId,
          assignment.travelClassId,
          assignment.coachNumber,
          assignment.seatNumber,
          assignment.rowNumber,
          assignment.label ?? null,
          assignment.outcome,
          assignment.originStationId,
          assignment.destinationStationId,
          assignment.originPosition,
          assignment.destinationPosition,
          toInt4Range(assignment.segment),
          hold.now,
        ],
      );
    }

    const identityByTripAndRef = new Map(
      hold.passengers.flatMap((passenger) =>
        passenger.identities.map(
          (identity) =>
            [`${identity.tripId}:${passenger.passengerRef}`, identity] as const,
        ),
      ),
    );

    for (const assignment of hold.assignments) {
      const identity = identityByTripAndRef.get(
        `${assignment.tripId}:${assignment.passengerRef}`,
      );
      if (!identity) {
        throw new HoldCoreError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          'Allocation referenced an unknown passenger identity.',
        );
      }

      await manager.query(
        `INSERT INTO seat_occupation
           (id, trip_seat_id, trip_id, segment, state, hold_expires_at,
            reference_id, hold_id, owner_id, passenger_ref, passenger_token,
            passenger_key_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4::int4range, 'held', $5, $6, $6, $7, $8,
                 $9, $10, $11, $11)`,
        [
          randomUUID(),
          assignment.tripSeatId,
          assignment.tripId,
          toInt4Range(assignment.segment),
          hold.expiresAt,
          hold.id,
          hold.ownerId,
          assignment.passengerRef,
          identity.passengerToken,
          identity.passengerKeyVersion,
          hold.now,
        ],
      );
    }
  }

  async insertCancellationTombstone(
    ctx: TransactionContext,
    props: {
      id: string;
      bookingKey: string;
      ownerId: string;
      fingerprint: string;
      now: Date;
    },
  ): Promise<void> {
    await managerOf(ctx).query(
      `INSERT INTO seat_hold_group
         (id, booking_key, owner_id, request_fingerprint, state, version,
          extension_used, expires_at, released_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'cancelled', 1, false, NULL, $5, $5, $5)
       ON CONFLICT (booking_key) DO NOTHING`,
      [props.id, props.bookingKey, props.ownerId, props.fingerprint, props.now],
    );
  }

  async releaseOccupations(
    ctx: TransactionContext,
    holdId: string,
    now: Date,
  ): Promise<void> {
    await managerOf(ctx).query(
      `UPDATE seat_occupation
       SET released_at = $2, updated_at = $2
       WHERE hold_id = $1
         AND state = 'held'
         AND released_at IS NULL`,
      [holdId, now],
    );
  }

  /** Returns false when another transition already moved the head. */
  async markTerminal(
    ctx: TransactionContext,
    holdId: string,
    state: 'released' | 'expired',
    version: number,
    now: Date,
  ): Promise<boolean> {
    const result = (await managerOf(ctx).query(
      `UPDATE seat_hold_group
       SET state = $2, version = $3, released_at = $4, updated_at = $4
       WHERE id = $1 AND state = 'held'
       RETURNING id`,
      [holdId, state, version, now],
    )) as { id: string }[];

    return rowCountOf(result) > 0;
  }

  /** Returns false when the one extension was already consumed. */
  async applyExtension(
    ctx: TransactionContext,
    holdId: string,
    expiresAt: Date,
    version: number,
    now: Date,
  ): Promise<boolean> {
    const result = (await managerOf(ctx).query(
      `UPDATE seat_hold_group
       SET expires_at = $2, extension_used = true, version = $3, updated_at = $4
       WHERE id = $1 AND state = 'held' AND extension_used = false
       RETURNING id`,
      [holdId, expiresAt, version, now],
    )) as { id: string }[];

    if (rowCountOf(result) === 0) return false;

    await managerOf(ctx).query(
      `UPDATE seat_occupation
       SET hold_expires_at = $2, updated_at = $3
       WHERE hold_id = $1
         AND state = 'held'
         AND released_at IS NULL`,
      [holdId, expiresAt, now],
    );

    return true;
  }

  async loadSnapshot(
    ctx: TransactionContext,
    holdId: string,
    serverNow: Date,
  ): Promise<HoldSnapshot> {
    const manager = managerOf(ctx);

    const holdRows = (await manager.query(
      `SELECT id,
              booking_key AS "bookingKey",
              owner_id AS "ownerId",
              request_fingerprint AS "requestFingerprint",
              state,
              version,
              extension_used AS "extensionUsed",
              expires_at AS "expiresAt",
              released_at AS "releasedAt"
       FROM seat_hold_group
       WHERE id = $1`,
      [holdId],
    )) as HoldDbRow[];

    const hold = holdRows[0];
    if (!hold) {
      throw new HoldCoreError(
        ErrorCode.HOLD_NOT_FOUND,
        'No hold exists for this booking key.',
      );
    }

    const legRows = (await manager.query(
      `SELECT trip_id AS "tripId",
              travel_class_id AS "travelClassId",
              origin_station_id AS "originStationId",
              destination_station_id AS "destinationStationId",
              origin_position AS "originPosition",
              destination_position AS "destinationPosition",
              outcome
       FROM seat_hold_leg
       WHERE hold_id = $1
       ORDER BY trip_id`,
      [holdId],
    )) as LegViewRow[];

    const assignmentRows = (await manager.query(
      `SELECT passenger_ref AS "passengerRef",
              passenger_key_version AS "passengerKeyVersion",
              trip_id AS "tripId",
              trip_seat_id AS "tripSeatId",
              travel_class_id AS "travelClassId",
              coach_number AS "coachNumber",
              seat_number AS "seatNumber",
              row_number AS "rowNumber",
              label,
              outcome,
              origin_station_id AS "originStationId",
              destination_station_id AS "destinationStationId",
              origin_position AS "originPosition",
              destination_position AS "destinationPosition"
       FROM seat_hold_assignment
       WHERE hold_id = $1
       ORDER BY trip_id, passenger_ref`,
      [holdId],
    )) as AssignmentViewRow[];

    const legs: HoldLegResult[] = legRows.map((row) => ({
      tripId: row.tripId,
      travelClassId: row.travelClassId,
      originStationId: row.originStationId,
      destinationStationId: row.destinationStationId,
      originPosition: Number(row.originPosition),
      destinationPosition: Number(row.destinationPosition),
      outcome: row.outcome,
      ...(row.outcome === AllocationOutcome.SPLIT
        ? { splitNotice: SEATS_SPLIT_NOTICE }
        : {}),
    }));

    const assignments: HoldSeatAssignment[] = assignmentRows.map((row) => ({
      passengerRef: row.passengerRef,
      passengerKeyVersion: Number(row.passengerKeyVersion),
      tripId: row.tripId,
      tripSeatId: row.tripSeatId,
      travelClassId: row.travelClassId,
      coachNumber: Number(row.coachNumber),
      seatNumber: row.seatNumber,
      rowNumber: Number(row.rowNumber),
      ...(row.label === null ? {} : { label: row.label }),
      outcome: row.outcome,
      originStationId: row.originStationId,
      destinationStationId: row.destinationStationId,
      originPosition: Number(row.originPosition),
      destinationPosition: Number(row.destinationPosition),
    }));

    let state = holdStateOf(hold.state);
    if (
      state === 'HELD' &&
      hold.expiresAt !== null &&
      asDate(hold.expiresAt).getTime() <= serverNow.getTime()
    ) {
      state = 'EXPIRED';
    }

    return {
      holdId: hold.id,
      bookingKey: hold.bookingKey,
      ownerId: hold.ownerId,
      state,
      version: Number(hold.version),
      extensionUsed: hold.extensionUsed,
      expiresAt:
        hold.expiresAt === null ? null : asDate(hold.expiresAt).toISOString(),
      serverNow: serverNow.toISOString(),
      allocationOutcome: composeAllocationOutcome(
        legs.map((leg) => leg.outcome),
      ),
      legs,
      assignments,
    };
  }
}

function rowCountOf(result: unknown[]): number {
  if (Array.isArray(result[0]) && typeof result[1] === 'number')
    return result[1];
  return result.length;
}

function holdStateOf(state: DbHoldState): HoldState {
  switch (state) {
    case 'held':
      return 'HELD';
    case 'released':
      return 'RELEASED';
    case 'expired':
      return 'EXPIRED';
    case 'cancelled':
      return 'CANCELLED';
  }
}

