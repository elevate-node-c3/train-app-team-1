import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { StationEntity } from '../stations/entities/station.entity.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import { SELLABLE_TRIP_STATUSES } from './trip-sellability.js';
import type { TripStopRow } from './trip-search.types.js';

interface RawStopRow {
  station_id: string;
  station_name_en: string;
  station_name_ar: string;
  arrival_at: Date | null;
  departure_at: Date | null;
}

/**
 * Resolve the earliest boardable origin and next alighting destination in one
 * ordered query, matching search even on repeated-station routes.
 * Restrict to sellable trips so draft or withdrawn itineraries do not leak.
 * idx_trip_stop_trip_station covers trip and endpoint lookups.
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
      .innerJoin(
        DatedTripEntity,
        't',
        't.id = s.trip AND t.status IN (:...sellableStatuses)',
      )
      .innerJoin(StationEntity, 'st', 'st.id = s.stationId')
      .select('s.station_id', 'station_id')
      .addSelect('st.name_en', 'station_name_en')
      .addSelect('st.name_ar', 'station_name_ar')
      .addSelect('s.arrival_at', 'arrival_at')
      .addSelect('s.departure_at', 'departure_at')
      .where('s.trip = :tripId')
      // Use the same earliest boarding position as findCandidates.
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
      // Repeat the origin lookup so the destination stays pinned to the same pair.
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
        sellableStatuses: [...SELLABLE_TRIP_STATUSES],
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
