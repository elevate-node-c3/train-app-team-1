import { Injectable } from '@nestjs/common';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { toInt4Range } from './segment.js';
import type { Segment } from './segment.js';

/** One (segment, class) count, named by station so catalog needs no stop table. */
export type SegmentCount = {
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  availableSeats: number;
};

interface CountRow {
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  availableSeats: number | string;
}

/**
 * Counts every station pair and class a change touches, in one query. The
 * availability predicate is the one AvailabilityRepository.countFor uses, so a
 * published count and a queried count cannot disagree.
 */
@Injectable()
export class AvailabilityCountsRepository {
  async countsOverlapping(
    ctx: TransactionContext,
    tripId: string,
    changed: Segment,
  ): Promise<SegmentCount[]> {
    const rows: CountRow[] = await entityManagerOf(ctx).query(
      `SELECT a.station_id AS "originStationId",
              b.station_id AS "destinationStationId",
              s.travel_class_id AS "travelClassId",
              count(*) FILTER (
                WHERE NOT EXISTS (
                  SELECT 1 FROM seat_occupation o
                  WHERE o.trip_seat_id = s.id
                    AND o.released_at IS NULL
                    -- Counts may use now(); the exclusion constraint's
                    -- predicate may not. An expired-but-unreleased hold
                    -- still blocks a write.
                    AND (o.state = 'sold' OR o.hold_expires_at > now())
                    AND o.segment && int4range(a.position, b.position)
                )
              )::int AS "availableSeats"
         FROM trip_stop a
         JOIN trip_stop b
           ON b.trip_id = a.trip_id AND b.position > a.position
         JOIN trip_seat s
           ON s.trip_id = a.trip_id
        WHERE a.trip_id = $1
          AND int4range(a.position, b.position) && $2::int4range
     GROUP BY a.station_id, b.station_id, s.travel_class_id`,
      [tripId, toInt4Range(changed)],
    );

    return rows.map((row) => ({
      originStationId: row.originStationId,
      destinationStationId: row.destinationStationId,
      travelClassId: row.travelClassId,
      availableSeats: Number(row.availableSeats),
    }));
  }
}
