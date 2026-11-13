import { Injectable } from '@nestjs/common';
import { cairoCivilDateOf, cairoDayBounds } from '@app/contracts';
import { DataSource } from 'typeorm';

import { StationEntity } from '../stations/entities/station.entity.js';
import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { TrainEntity } from '../trains/entities/train.entity.js';
import { TrainTypeEntity } from '../trains/entities/train-type.entity.js';
import { TravelClassEntity } from '../trains/entities/travel-class.entity.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import {
  MAX_TRIP_DAY_SPAN_DAYS,
  SELLABLE_TRIP_STATUSES,
} from './trip-sellability.js';
import type {
  PassengerSegmentRow,
  RouteServedProbe,
  TripSearchRow,
} from './trip-search.types.js';

interface RawSegmentRow {
  origin_station_id: string;
  destination_station_id: string;
  origin_departure_at: Date;
  destination_arrival_at: Date;
}

interface RawRow {
  trip_id: string;
  train_number: number;
  train_type_id: string;
  train_type_en: string;
  train_type_ar: string;
  origin_station_id: string;
  origin_name_en: string;
  origin_name_ar: string;
  origin_departure_at: Date;
  destination_station_id: string;
  destination_name_en: string;
  destination_name_ar: string;
  destination_arrival_at: Date;
  travel_class_name_en: string;
  travel_class_name_ar: string;
  intermediate_stops: string | number;
  class_capacity: string | number;
  fare_piastres: string | number | null;
}

/**
 * Sum class capacity in SQL from the published snapshot to avoid shipping full seat maps.
 * JSON IDs are text, so cast travelClassId to text rather than UUID.
 */
const CLASS_CAPACITY_FRAGMENT = `(
  SELECT COALESCE(SUM(
           jsonb_array_length(COALESCE(r.value -> 'leftSeats',  '[]'::jsonb)) +
           jsonb_array_length(COALESCE(r.value -> 'rightSeats', '[]'::jsonb))
         ), 0)::int
  FROM jsonb_array_elements(t.composition_snapshot) AS c(value)
  CROSS JOIN LATERAL jsonb_array_elements(
         COALESCE(c.value -> 'coachLayout' -> 'rows', '[]'::jsonb)
       ) AS r(value)
  WHERE c.value -> 'travelClass' ->> 'id' = CAST(:travelClassId AS text)
)`;

/**
 * Resolve the newest price effective at now; return null for uncovered segments.
 * The correlated SQL reads uq_fare_effective_version backwards, so no extra index is needed.
 */
const CURRENT_FARE_FRAGMENT = `(
  SELECT fa.amount_piastres
  FROM fare fa
  WHERE fa.train_id               = t.train_id
    AND fa.travel_class_id        = :travelClassId
    AND fa.origin_station_id      = o.station_id
    AND fa.destination_station_id = d.station_id
    AND fa.effective_from        <= :now
  ORDER BY fa.effective_from DESC
  LIMIT 1
)`;

@Injectable()
export class TripSearchRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Load the day's candidates in one query, without per-trip statements.
   * DISTINCT ON controls SQL order; sort results in memory after deduplication.
   */
  async findCandidates(params: {
    originStationId: string;
    destinationStationId: string;
    travelClassId: string;
    /** The Cairo civil date being searched, 'YYYY-MM-DD'. */
    serviceDate: string;
    trainNumber: number | null;
    now: Date;
  }): Promise<TripSearchRow[]> {
    const { startUtc, endUtc } = cairoDayBounds(params.serviceDate);

    const raw = await this.dataSource
      .getRepository(DatedTripEntity)
      .createQueryBuilder('t')
      // Keep one row per trip and the earliest valid pair on repeated-station routes.
      .distinctOn(['t.id'])

      .innerJoin(
        TripStopEntity,
        'o',
        'o.trip = t.id AND o.stationId = :originStationId AND o.departureAt IS NOT NULL',
      )
      // Only a later stop is a valid destination; reverse pairs do not match.
      .innerJoin(
        TripStopEntity,
        'd',
        'd.trip = t.id AND d.stationId = :destinationStationId AND d.position > o.position AND d.arrivalAt IS NOT NULL',
      )
      .innerJoin(TrainEntity, 'tr', 'tr.id = t.train')
      .innerJoin(TrainTypeEntity, 'ty', 'ty.id = tr.trainType')
      .innerJoin(StationEntity, 'so', 'so.id = o.stationId')
      .innerJoin(StationEntity, 'sd', 'sd.id = d.stationId')
      .innerJoin(TravelClassEntity, 'tc', 'tc.id = :travelClassId')

      .select('t.id', 'trip_id')
      .addSelect('tr.train_number', 'train_number')
      .addSelect('ty.id', 'train_type_id')
      .addSelect('ty.name_en', 'train_type_en')
      .addSelect('ty.name_ar', 'train_type_ar')
      .addSelect('o.station_id', 'origin_station_id')
      .addSelect('so.name_en', 'origin_name_en')
      .addSelect('so.name_ar', 'origin_name_ar')
      .addSelect('o.departure_at', 'origin_departure_at')
      .addSelect('d.station_id', 'destination_station_id')
      .addSelect('sd.name_en', 'destination_name_en')
      .addSelect('sd.name_ar', 'destination_name_ar')
      .addSelect('d.arrival_at', 'destination_arrival_at')
      .addSelect('tc.name_en', 'travel_class_name_en')
      .addSelect('tc.name_ar', 'travel_class_name_ar')
      // Count intermediate stops from dense positions; no extra join.
      .addSelect('d.position - o.position - 1', 'intermediate_stops')
      .addSelect(CLASS_CAPACITY_FRAGMENT, 'class_capacity')
      .addSelect(CURRENT_FARE_FRAGMENT, 'fare_piastres')

      .where('t.status IN (:...sellableStatuses)')
      // serviceDate only prunes indexed rows; the origin departure range below
      // determines correctness, including overnight departures.
      .andWhere(
        't.serviceDate BETWEEN (CAST(:serviceDate AS date) - CAST(:daySpan AS int)) AND (CAST(:serviceDate AS date) + 1)',
      )
      // Search by the passenger's Cairo departure date, not the train's start date.
      // Use tzdata's half-open day bounds, not a fixed 24-hour span.
      .andWhere('o.departureAt >= :dayStart')
      .andWhere('o.departureAt < :dayEnd')
      // Optional train-number narrowing stays in the same query.
      .andWhere(
        '(CAST(:trainNumber AS int) IS NULL OR tr.trainNumber = CAST(:trainNumber AS int))',
      )

      .orderBy('t.id')
      .addOrderBy('o.position')
      .addOrderBy('d.position')
      .setParameters({
        originStationId: params.originStationId,
        destinationStationId: params.destinationStationId,
        travelClassId: params.travelClassId,
        now: params.now,
        sellableStatuses: [...SELLABLE_TRIP_STATUSES],
        serviceDate: params.serviceDate,
        daySpan: MAX_TRIP_DAY_SPAN_DAYS,
        dayStart: startUtc,
        dayEnd: endUtc,
        trainNumber: params.trainNumber,
      })
      .getRawMany<RawRow>();

    return (
      raw
        .map((row) => ({
          tripId: row.trip_id,
          trainNumber: Number(row.train_number),
          trainTypeId: row.train_type_id,
          trainTypeEn: row.train_type_en,
          trainTypeAr: row.train_type_ar,
          originStationId: row.origin_station_id,
          originNameEn: row.origin_name_en,
          originNameAr: row.origin_name_ar,
          originDepartureAt: row.origin_departure_at,
          destinationStationId: row.destination_station_id,
          destinationNameEn: row.destination_name_en,
          destinationNameAr: row.destination_name_ar,
          destinationArrivalAt: row.destination_arrival_at,
          travelClassNameEn: row.travel_class_name_en,
          travelClassNameAr: row.travel_class_name_ar,
          intermediateStops: Number(row.intermediate_stops),
          classCapacity: Number(row.class_capacity),
          farePiastres:
            row.fare_piastres === null ? null : Number(row.fare_piastres),
        }))
        // No coach in the requested class means no result; sold-out trips still
        // have capacity and must remain in results.
        .filter((row) => row.classCapacity > 0)
        // Sort by departure, then train number for deterministic ties.
        .sort(
          (left, right) =>
            left.originDepartureAt.getTime() -
              right.originDepartureAt.getTime() ||
            left.trainNumber - right.trainNumber,
        )
    );
  }

  /**
   * Use server-read outbound instants to bound returns, never client-supplied times.
   * Only sellable trips qualify; refuse if withdrawal happened after search.
   * Repeated stations use the earliest valid pairing, matching the offered journey.
   */
  async findPassengerSegment(
    tripId: string,
    originStationId: string,
    destinationStationId: string,
  ): Promise<PassengerSegmentRow | null> {
    const raw = await this.dataSource
      .getRepository(DatedTripEntity)
      .createQueryBuilder('t')
      .innerJoin(
        TripStopEntity,
        'o',
        'o.trip = t.id AND o.stationId = :originStationId AND o.departureAt IS NOT NULL',
      )
      .innerJoin(
        TripStopEntity,
        'd',
        'd.trip = t.id AND d.stationId = :destinationStationId AND d.position > o.position AND d.arrivalAt IS NOT NULL',
      )
      .select('o.station_id', 'origin_station_id')
      .addSelect('d.station_id', 'destination_station_id')
      .addSelect('o.departure_at', 'origin_departure_at')
      .addSelect('d.arrival_at', 'destination_arrival_at')
      .where('t.id = :tripId')
      .andWhere('t.status IN (:...sellableStatuses)')
      .orderBy('o.position', 'ASC')
      .addOrderBy('d.position', 'ASC')
      .limit(1)
      .setParameters({
        tripId,
        originStationId,
        destinationStationId,
        sellableStatuses: [...SELLABLE_TRIP_STATUSES],
      })
      .getRawOne<RawSegmentRow>();

    if (!raw) return null;

    return {
      originStationId: raw.origin_station_id,
      destinationStationId: raw.destination_station_id,
      originDepartureAt: raw.origin_departure_at,
      destinationArrivalAt: raw.destination_arrival_at,
      cairoDepartureDate: cairoCivilDateOf(raw.origin_departure_at),
    };
  }

  /**
   * Check published timetables for date-independent route existence, even before
   * any dated trips exist. Ask about the named train only when needed.
   */
  async probeRouteServed(
    originStationId: string,
    destinationStationId: string,
    trainNumber: number | null,
  ): Promise<RouteServedProbe> {
    const routeServed = await this.servedQuery(
      originStationId,
      destinationStationId,
    ).getExists();

    if (!routeServed || trainNumber === null) {
      return { routeServed, trainServesRoute: false };
    }

    const trainServesRoute = await this.servedQuery(
      originStationId,
      destinationStationId,
    )
      .innerJoin(
        TrainEntity,
        'tr',
        'tr.id = tm.train AND tr.trainNumber = :trainNumber',
        {
          trainNumber,
        },
      )
      .getExists();

    return { routeServed, trainServesRoute };
  }

  /** A published timetable stopping at both stations, in travel order. */
  private servedQuery(originStationId: string, destinationStationId: string) {
    return this.dataSource
      .getRepository(TimetableEntity)
      .createQueryBuilder('tm')
      .innerJoin(
        TimetableStopEntity,
        'a',
        'a.timetable = tm.id AND a.stationId = :originStationId',
      )
      .innerJoin(
        TimetableStopEntity,
        'b',
        'b.timetable = tm.id AND b.stationId = :destinationStationId AND b.position > a.position',
      )
      .where('tm.status = :published')
      .setParameters({
        originStationId,
        destinationStationId,
        published: 'published',
      });
  }
}
