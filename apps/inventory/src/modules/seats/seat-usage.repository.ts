import { Injectable } from '@nestjs/common';
import type { TripSeatUsage } from '@app/contracts';
import { DataSource } from 'typeorm';

interface UsageRow {
  trip_id: string;
  sold_count: string;
  held_count: string;
  station_ids: string[] | null;
}

/**
 * One grouped query over seat_occupation and trip_stop, bounded regardless of
 * how many trip ids are asked for (spec §8, same shape as AvailabilityRepository).
 */
@Injectable()
export class SeatUsageRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Always returns one row per requested trip id, including trips with no usage. */
  async usageFor(tripIds: string[]): Promise<TripSeatUsage[]> {
    if (tripIds.length === 0) return [];

    // Catalog batches these calls; a duplicated id must not double a count.
    const uniqueTripIds = Array.from(new Set(tripIds));

    const rows: UsageRow[] = await this.dataSource.query(
      `WITH active AS (
         SELECT trip_id, state, segment
         FROM seat_occupation
         WHERE trip_id = ANY($1::uuid[])
           AND released_at IS NULL
           -- Counts may use now(); the exclusion constraint's predicate may not
           -- (spec §6.3). An expired-but-unreleased hold still blocks a write
           -- but no longer counts as usage.
           AND (state = 'sold' OR hold_expires_at > now())
       ),
       counts AS (
         SELECT trip_id,
           count(*) FILTER (WHERE state = 'sold') AS sold_count,
           count(*) FILTER (WHERE state = 'held') AS held_count
         FROM active
         GROUP BY trip_id
       ),
       stations AS (
         -- Both ends inclusive: the passenger is physically at the destination
         -- station even though the seat is free from there (spec §6.10).
         SELECT a.trip_id, array_agg(DISTINCT ts.station_id) AS station_ids
         FROM active a
         JOIN trip_stop ts
           ON ts.trip_id = a.trip_id
          AND ts.position BETWEEN lower(a.segment) AND upper(a.segment)
         GROUP BY a.trip_id
       )
       SELECT wanted.trip_id,
         COALESCE(counts.sold_count, 0) AS sold_count,
         COALESCE(counts.held_count, 0) AS held_count,
         stations.station_ids AS station_ids
       FROM unnest($1::uuid[]) AS wanted(trip_id)
       LEFT JOIN counts ON counts.trip_id = wanted.trip_id
       LEFT JOIN stations ON stations.trip_id = wanted.trip_id`,
      [uniqueTripIds],
    );

    return rows.map((row) => ({
      tripId: row.trip_id,
      soldCount: Number(row.sold_count),
      heldCount: Number(row.held_count),
      stationIdsInUse: row.station_ids ?? [],
    }));
  }
}
