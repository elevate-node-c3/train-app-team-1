import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';

import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { InventoryTripEntity } from './entities/inventory-trip.entity.js';
import { parseInt4Range, stationsInUse } from './segment.js';
import type { SeatPlan } from './seat-plan.js';

export type ApplyOutcome =
  | { kind: 'created'; seatCount: number; seatCountByClass: Record<string, number> }
  | { kind: 'skipped'; reason: 'stale-version' }
  | { kind: 'refused'; occupiedSeatNumbers: string[]; occupiedStationIds: string[] };

interface ExistingSeatRow {
  id: string;
  seatNumber: number;
  coachNumber: number;
}

interface ExistingCoachRow {
  id: string;
  coachNumber: number;
}

/**
 * Writes a seat plan all-or-nothing. Neither method opens its own transaction:
 * the caller (Task 9's consumer) owns one TransactionContext per publication
 * so the outbox append lands with the same writes (spec §9 step 4).
 */
@Injectable()
export class SeatPlanRepository {
  async apply(ctx: TransactionContext, plan: SeatPlan): Promise<ApplyOutcome> {
    const manager = entityManagerOf(ctx);

    // A savepoint, not a second transaction: the version-guard upsert below
    // must be reversible when refusalFor finds an occupied seat the new plan
    // would drop, without discarding anything the caller already wrote to ctx.
    const savepoint = `seat_plan_apply_${randomUUID().replaceAll('-', '_')}`;
    await manager.query(`SAVEPOINT ${savepoint}`);

    // Single atomic statement so a brand-new trip and a republished one share
    // one decision point: whichever version is higher always wins, regardless
    // of which concurrent INSERT ... ON CONFLICT reaches Postgres first (a
    // plain INSERT with no conflict target would let two concurrent
    // first-time applies race on commit order instead of version).
    const upserted: { id: string }[] = await manager.query(
      `INSERT INTO inventory_trip
         (id, status, timetable_version, train_id, train_number, service_date)
       VALUES ($1, 'on_sale', $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET timetable_version = EXCLUDED.timetable_version,
             updated_at = now()
         WHERE inventory_trip.status <> 'closed'
           AND inventory_trip.timetable_version < EXCLUDED.timetable_version
       RETURNING id`,
      [plan.tripId, plan.timetableVersion, plan.trainId, plan.trainNumber, plan.serviceDate],
    );

    if (upserted.length === 0) {
      // WHERE filtered out the update: either closed, or stale/equal version.
      await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { kind: 'skipped', reason: 'stale-version' };
    }

    const refusal = await this.refusalFor(manager, plan);
    if (refusal) {
      await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
      return refusal;
    }

    await this.replaceStops(manager, plan);
    await this.dropUnplannedSeatsAndCoaches(manager, plan);
    const coachIdByNumber = await this.upsertCoaches(manager, plan);
    await this.upsertSeats(manager, plan, coachIdByNumber);

    await manager.query(`RELEASE SAVEPOINT ${savepoint}`);

    return {
      kind: 'created',
      seatCount: plan.seats.length,
      seatCountByClass: this.seatCountByClass(plan),
    };
  }

  /**
   * Touches no occupation: existing holds and sold tickets survive for the
   * refund flow (Task 9's withdrawn-trip handler).
   */
  async close(ctx: TransactionContext, tripId: string): Promise<void> {
    const manager = entityManagerOf(ctx);
    await manager
      .getRepository(InventoryTripEntity)
      .update({ id: tripId }, { status: 'closed' });
  }

  private seatCountByClass(plan: SeatPlan): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const seat of plan.seats) {
      counts[seat.travelClassId] = (counts[seat.travelClassId] ?? 0) + 1;
    }
    return counts;
  }

  /** Keys existing and planned seats the same way: coach number + seat number. */
  private desiredSeatKeys(plan: SeatPlan): Set<string> {
    const coachNumberById = new Map(
      plan.coaches.map((coach) => [coach.id, coach.coachNumber]),
    );
    return new Set(
      plan.seats.map((seat) => `${coachNumberById.get(seat.coachId)}:${seat.seatNumber}`),
    );
  }

  private async existingSeats(
    manager: EntityManager,
    tripId: string,
  ): Promise<ExistingSeatRow[]> {
    return manager.query(
      `SELECT ts.id AS "id", ts.seat_number AS "seatNumber", tc.coach_number AS "coachNumber"
       FROM trip_seat ts JOIN trip_coach tc ON tc.id = ts.trip_coach_id
       WHERE ts.trip_id = $1`,
      [tripId],
    );
  }

  /**
   * Refuse before writing anything if the new layout would drop a seat an
   * active occupation still claims. A released occupation does not protect
   * its seat — only rows with released_at IS NULL count.
   */
  private async refusalFor(
    manager: EntityManager,
    plan: SeatPlan,
  ): Promise<ApplyOutcome | null> {
    const existing = await this.existingSeats(manager, plan.tripId);
    const desired = this.desiredSeatKeys(plan);
    const dropped = existing.filter(
      (seat) => !desired.has(`${seat.coachNumber}:${seat.seatNumber}`),
    );
    if (dropped.length === 0) return null;

    const occupied: { seatNumber: number; segment: string }[] = await manager.query(
      `SELECT ts.seat_number AS "seatNumber", so.segment AS "segment"
       FROM seat_occupation so JOIN trip_seat ts ON ts.id = so.trip_seat_id
       WHERE so.trip_seat_id = ANY($1::uuid[]) AND so.released_at IS NULL`,
      [dropped.map((seat) => seat.id)],
    );
    if (occupied.length === 0) return null;

    const stops: { position: number; stationId: string }[] = await manager.query(
      `SELECT position, station_id AS "stationId" FROM trip_stop WHERE trip_id = $1`,
      [plan.tripId],
    );
    const stationByPosition = new Map(stops.map((stop) => [stop.position, stop.stationId]));

    const occupiedStationIds = new Set<string>();
    for (const row of occupied) {
      // No timestamp decides this: stationsInUse reads only the segment's stop order.
      for (const position of stationsInUse(parseInt4Range(row.segment))) {
        const stationId = stationByPosition.get(position);
        if (stationId) occupiedStationIds.add(stationId);
      }
    }

    return {
      kind: 'refused',
      occupiedSeatNumbers: [...new Set(occupied.map((row) => String(row.seatNumber)))],
      occupiedStationIds: [...occupiedStationIds],
    };
  }

  /** Stops carry no occupation; always replace them with the plan's current order. */
  private async replaceStops(manager: EntityManager, plan: SeatPlan): Promise<void> {
    await manager.query(`DELETE FROM trip_stop WHERE trip_id = $1`, [plan.tripId]);
    if (plan.stops.length === 0) return;

    const values: string[] = [];
    const params: unknown[] = [];
    plan.stops.forEach((stop, index) => {
      const offset = index * 3;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
      params.push(plan.tripId, stop.position, stop.stationId);
    });

    await manager.query(
      `INSERT INTO trip_stop (trip_id, position, station_id) VALUES ${values.join(', ')}`,
      params,
    );
  }

  /** refusalFor already proved none of these are occupied. */
  private async dropUnplannedSeatsAndCoaches(
    manager: EntityManager,
    plan: SeatPlan,
  ): Promise<void> {
    const existing = await this.existingSeats(manager, plan.tripId);
    const desired = this.desiredSeatKeys(plan);
    const droppedSeatIds = existing
      .filter((seat) => !desired.has(`${seat.coachNumber}:${seat.seatNumber}`))
      .map((seat) => seat.id);

    if (droppedSeatIds.length > 0) {
      // refusalFor already proved none of these are actively occupied, so any
      // remaining seat_occupation rows here are released; RESTRICT still
      // blocks the seat delete until those released rows go too.
      await manager.query(`DELETE FROM seat_occupation WHERE trip_seat_id = ANY($1::uuid[])`, [
        droppedSeatIds,
      ]);
      await manager.query(`DELETE FROM trip_seat WHERE id = ANY($1::uuid[])`, [droppedSeatIds]);
    }

    const existingCoaches: ExistingCoachRow[] = await manager.query(
      `SELECT id, coach_number AS "coachNumber" FROM trip_coach WHERE trip_id = $1`,
      [plan.tripId],
    );
    const desiredCoachNumbers = new Set(plan.coaches.map((coach) => coach.coachNumber));
    const droppedCoachNumbers = existingCoaches
      .filter((coach) => !desiredCoachNumbers.has(coach.coachNumber))
      .map((coach) => coach.coachNumber);

    if (droppedCoachNumbers.length > 0) {
      await manager.query(
        `DELETE FROM trip_coach WHERE trip_id = $1 AND coach_number = ANY($2::int[])`,
        [plan.tripId, droppedCoachNumbers],
      );
    }
  }

  /** Insert coaches new to this trip; an existing coach number keeps its row and id. */
  private async upsertCoaches(
    manager: EntityManager,
    plan: SeatPlan,
  ): Promise<Map<number, string>> {
    if (plan.coaches.length > 0) {
      const values: string[] = [];
      const params: unknown[] = [];
      plan.coaches.forEach((coach, index) => {
        const offset = index * 4;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
        params.push(coach.id, plan.tripId, coach.coachNumber, coach.travelClassId);
      });

      await manager.query(
        `INSERT INTO trip_coach (id, trip_id, coach_number, travel_class_id)
         VALUES ${values.join(', ')}
         ON CONFLICT (trip_id, coach_number) DO NOTHING`,
        params,
      );
    }

    const rows: ExistingCoachRow[] = await manager.query(
      `SELECT id, coach_number AS "coachNumber" FROM trip_coach WHERE trip_id = $1`,
      [plan.tripId],
    );
    return new Map(rows.map((row) => [row.coachNumber, row.id]));
  }

  /** Insert seats new to this trip, against each coach's real (possibly pre-existing) id. */
  private async upsertSeats(
    manager: EntityManager,
    plan: SeatPlan,
    coachIdByNumber: Map<number, string>,
  ): Promise<void> {
    if (plan.seats.length === 0) return;

    const coachNumberById = new Map(
      plan.coaches.map((coach) => [coach.id, coach.coachNumber]),
    );
    const values: string[] = [];
    const params: unknown[] = [];

    plan.seats.forEach((seat, index) => {
      const coachNumber = coachNumberById.get(seat.coachId);
      const coachId = coachNumber === undefined ? undefined : coachIdByNumber.get(coachNumber);
      if (!coachId) {
        throw new Error(`Seat ${seat.id} names coach ${seat.coachId}, which is not in this plan`);
      }

      const offset = index * 6;
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`,
      );
      params.push(
        seat.id,
        plan.tripId,
        coachId,
        parseInt(seat.seatNumber, 10),
        seat.travelClassId,
        seat.side,
      );
    });

    await manager.query(
      `INSERT INTO trip_seat (id, trip_id, trip_coach_id, seat_number, travel_class_id, side)
       VALUES ${values.join(', ')}
       ON CONFLICT (trip_coach_id, seat_number) DO NOTHING`,
      params,
    );
  }
}
