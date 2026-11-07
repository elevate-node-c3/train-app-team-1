import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { StationEntity } from '../stations/entities/station.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import type { TripStopRow } from './trip-search.types.js';

interface RawStopRow {
  station_id: string;
  station_name_en: string;
  station_name_ar: string;
  arrival_at: Date | null;
  departure_at: Date | null;
}

/**
 * The stops one passenger actually travels through.
 *
 * One statement, ordered by position. The endpoints are resolved exactly as
 * search resolves them -- earliest boardable stop at the origin, then the
 * earliest alighting stop after it -- so the list always agrees with the
 * result that offered it, including on a route that calls at a station twice.
 *
 * `idx_trip_stop_trip_station` serves both the trip filter and the two
 * endpoint lookups, so this needs no index of its own.
 */
@Injectable()
export class TripStopsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findStops(params: {
    tripId: string;
    originStationId: string;
    destinationStationId: string;
  }): Promise<TripStopRow[]> {
    const raw = await this.dataSource
      .getRepository(TripStopEntity)
      .createQueryBuilder('s')
      .innerJoin(StationEntity, 'st', 'st.id = s.stationId')
      .select('s.station_id', 'station_id')
      .addSelect('st.name_en', 'station_name_en')
      .addSelect('st.name_ar', 'station_name_ar')
      .addSelect('s.arrival_at', 'arrival_at')
      .addSelect('s.departure_at', 'departure_at')
      .where('s.trip = :tripId')
      // The earliest boardable stop at the passenger's origin, the same
      // pairing `findCandidates` uses.
      .andWhere(
        `s.position >= (
          SELECT bo.position FROM trip_stop bo
          WHERE bo.trip_id = s.trip_id
            AND bo.station_id = :originStationId
            AND bo.departure_at IS NOT NULL
          ORDER BY bo.position ASC
          LIMIT 1
        )`,
      )
      // The first stop at the destination after boarding. Its subquery repeats
      // the boarding lookup so both ends are pinned to one deterministic pair.
      .andWhere(
        `s.position <= (
          SELECT bd.position FROM trip_stop bd
          WHERE bd.trip_id = s.trip_id
            AND bd.station_id = :destinationStationId
            AND bd.arrival_at IS NOT NULL
            AND bd.position > (
              SELECT bo.position FROM trip_stop bo
              WHERE bo.trip_id = s.trip_id
                AND bo.station_id = :originStationId
                AND bo.departure_at IS NOT NULL
              ORDER BY bo.position ASC
              LIMIT 1
            )
          ORDER BY bd.position ASC
          LIMIT 1
        )`,
      )
      .orderBy('s.position', 'ASC')
      .setParameters({
        tripId: params.tripId,
        originStationId: params.originStationId,
        destinationStationId: params.destinationStationId,
      })
      .getRawMany<RawStopRow>();

    return raw.map((row) => ({
      stationId: row.station_id,
      stationNameEn: row.station_name_en,
      stationNameAr: row.station_name_ar,
      arrivalAt: row.arrival_at,
      departureAt: row.departure_at,
    }));
  }
}
