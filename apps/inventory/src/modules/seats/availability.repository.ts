import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { parseInt4Range, toInt4Range } from './segment.js';
import type { Segment } from './segment.js';

export type AvailabilityQuery = {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
};

export type AvailabilityCount = {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  availableSeats: number;
};

/** A query whose stations are already resolved to stop positions, as a segment. */
export type ResolvedAvailabilityQuery = {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  segment: Segment;
};

interface PositionRow {
  trip_id: string;
  station_id: string;
  position: number;
}

interface CountRow {
  trip_id: string;
  travel_class_id: string;
  segment: string;
  available: string;
}

/** Joins a resolved query back to its own result row by trip, class and segment. */
function rowKey(tripId: string, travelClassId: string, segment: Segment): string {
  return `${tripId}:${travelClassId}:${toInt4Range(segment)}`;
}

/**
 * Two bounded round trips for a whole page of queries, per spec §8. Raises
 * nothing itself — a missing station or a reversed pair is a TypeScript-side
 * decision made from positionsFor's result, not a SQL error.
 */
@Injectable()
export class AvailabilityRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Resolves every (tripId, stationId) the page mentions to a stop position, in one query. */
  async positionsFor(queries: AvailabilityQuery[]): Promise<Map<string, Map<string, number>>> {
    const result = new Map<string, Map<string, number>>();
    if (queries.length === 0) return result;

    const wantedTripIds: string[] = [];
    const wantedStationIds: string[] = [];
    const seen = new Set<string>();
    for (const query of queries) {
      for (const stationId of [query.originStationId, query.destinationStationId]) {
        const key = `${query.tripId}:${stationId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        wantedTripIds.push(query.tripId);
        wantedStationIds.push(stationId);
      }
    }

    const rows: PositionRow[] = await this.dataSource.query(
      `SELECT ts.trip_id AS "trip_id", ts.station_id AS "station_id", ts.position AS "position"
       FROM trip_stop ts
       JOIN unnest($1::uuid[], $2::uuid[]) AS wanted(trip_id, station_id)
         ON ts.trip_id = wanted.trip_id AND ts.station_id = wanted.station_id`,
      [wantedTripIds, wantedStationIds],
    );

    for (const row of rows) {
      let byStation = result.get(row.trip_id);
      if (!byStation) {
        byStation = new Map();
        result.set(row.trip_id, byStation);
      }
      byStation.set(row.station_id, Number(row.position));
    }

    return result;
  }

  /**
   * The spec §8 count query, verbatim, with the wanted segments passed as
   * parallel arrays through unnest. A trip and class with no seats at all
   * yields no row here, by design — AvailabilityService fills that gap.
   */
  async countFor(resolved: ResolvedAvailabilityQuery[]): Promise<AvailabilityCount[]> {
    if (resolved.length === 0) return [];

    // A duplicated wanted row multiplies the JOIN and doubles count(s.id), so
    // collapse identical queries before unnesting them.
    const wantedByKey = new Map(
      resolved.map((query) => [
        rowKey(query.tripId, query.travelClassId, query.segment),
        query,
      ]),
    );
    const wanted = [...wantedByKey.values()];

    const tripIds = wanted.map((query) => query.tripId);
    const travelClassIds = wanted.map((query) => query.travelClassId);
    const segments = wanted.map((query) => toInt4Range(query.segment));

    const rows: CountRow[] = await this.dataSource.query(
      `WITH wanted(trip_id, travel_class_id, segment) AS (
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::int4range[])
       )
       SELECT w.trip_id, w.travel_class_id, w.segment::text AS segment, count(s.id) AS available
       FROM wanted w
       JOIN trip_seat s
         ON s.trip_id = w.trip_id
        AND s.travel_class_id = w.travel_class_id
       WHERE NOT EXISTS (
         SELECT 1 FROM seat_occupation o
         WHERE o.trip_seat_id = s.id
           AND o.released_at IS NULL
           -- Counts may use now(); the exclusion constraint's predicate may not
           -- (spec §6.3). An expired-but-unreleased hold still blocks a write.
           AND (o.state = 'sold' OR o.hold_expires_at > now())
           AND o.segment && w.segment
       )
       GROUP BY w.trip_id, w.travel_class_id, w.segment`,
      [tripIds, travelClassIds, segments],
    );

    const originalByKey = wantedByKey;

    return rows.map((row) => {
      const original = originalByKey.get(
        rowKey(row.trip_id, row.travel_class_id, parseInt4Range(row.segment)),
      );
      if (!original) {
        throw new Error(
          `countFor returned a row matching no query: ${row.trip_id}/${row.travel_class_id}/${row.segment}`,
        );
      }
      return {
        tripId: original.tripId,
        travelClassId: original.travelClassId,
        originStationId: original.originStationId,
        destinationStationId: original.destinationStationId,
        availableSeats: Number(row.available),
      };
    });
  }
}
