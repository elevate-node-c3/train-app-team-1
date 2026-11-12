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
 * Seats in the requested class on this trip, summed out of the published
 * composition snapshot.
 *
 * A raw fragment because the query builder has no vocabulary for unnesting
 * jsonb, and because the alternative -- selecting `composition_snapshot` and
 * summing in TypeScript -- would ship every coach's full seat map for every
 * candidate trip, which is the one part of this row that is genuinely large.
 *
 * `->> 'id'` yields text, so the parameter is cast to text rather than left to
 * be inferred as uuid from its other uses.
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
 * The fare in force for this segment: the newest row whose `effective_from`
 * has arrived.
 *
 * A raw fragment because it is a correlated `ORDER BY ... LIMIT 1` against the
 * outer row's train and both stations, which the builder cannot express as a
 * selected scalar. It reads the existing
 * `uq_fare_effective_version (train_id, travel_class_id, origin, destination,
 * effective_from)` index backwards, so it needs no index of its own.
 *
 * Null when nothing covers the segment -- reported rather than hidden, so the
 * service can drop an unpriceable trip knowingly.
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
   * A day's sellable candidate trips between two stations, in one statement.
   *
   * Nothing here loops over rows, so the cost does not grow with the number of
   * trips found (TA-28). The default order is applied after the fact: `DISTINCT
   * ON` dictates the SQL ordering, and a day between two stations is tens of
   * rows, so sorting them in memory is cheaper than a wrapping subquery and is
   * also where CAT-4's alternative sorts will live.
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
      // One row per trip, even when a route calls at a station twice. Ordering
      // by both positions makes this keep the earliest valid pairing, which is
      // the journey a traveller would actually make.
      .distinctOn(['t.id'])

      // Where the passenger boards.
      .innerJoin(
        TripStopEntity,
        'o',
        'o.trip = t.id AND o.stationId = :originStationId AND o.departureAt IS NOT NULL',
      )
      // Where the passenger alights: any LATER stop of the same route.
      // `d.position > o.position` is the travel-order rule (BR-15), and it is
      // what makes the reverse direction return nothing.
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
      // Arithmetic on dense positions, so no third join and no COUNT(*) per row.
      .addSelect('d.position - o.position - 1', 'intermediate_stops')
      .addSelect(CLASS_CAPACITY_FRAGMENT, 'class_capacity')
      .addSelect(CURRENT_FARE_FRAGMENT, 'fare_piastres')

      .where('t.status IN (:...sellableStatuses)')
      // Pruning only, so the service_date index stays usable. The CORRECTNESS
      // predicate is the departure range below: a trip dated D can depart the
      // passenger's origin on D+1.
      .andWhere(
        't.serviceDate BETWEEN (CAST(:serviceDate AS date) - CAST(:daySpan AS int)) AND (CAST(:serviceDate AS date) + 1)',
      )
      // BR-16: a trip belongs to the Cairo date it leaves the PASSENGER's
      // origin, not the date the train left its first station. Half-open, and
      // computed from tzdata rather than by adding 24h, so it survives a
      // daylight-saving change.
      .andWhere('o.departureAt >= :dayStart')
      .andWhere('o.departureAt < :dayEnd')
      // Optional narrowing (BR-18); one statement serves both shapes.
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
        // A train with no coach of the requested class is not a result at all,
        // which is a different thing from sold out -- that has capacity and no
        // seats left, and IS returned.
        .filter((row) => row.classCapacity > 0)
        // The default order (BR-18), tie-broken on train number so the output is
        // deterministic.
        .sort(
          (left, right) =>
            left.originDepartureAt.getTime() -
              right.originDepartureAt.getTime() ||
            left.trainNumber - right.trainNumber,
        )
    );
  }

  /**
   * The one segment a traveller chose as their outbound.
   *
   * This is the server's half of BR-20: the return search is bounded by the
   * departure and arrival instants read here, never by times a client sent.
   * Non-sellable trips are excluded for the same reason they are absent from
   * search, so a trip withdrawn between the two lists yields nothing and the
   * caller can refuse instead of inventing a return bound.
   *
   * A loop route can stop at both stations more than once. Ordering the
   * positions keeps the earliest pairing, which is the same journey search
   * offered. One statement, one row.
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
   * Is this pair served at all, and by this train?
   *
   * Asked of the timetables rather than the dated trips on purpose: it answers
   * "does this route exist", which is date-independent, so it stays correct on
   * dates nothing has been generated for -- and it is the only question that
   * can be answered before TA-16 materializes any trips.
   *
   * The second question is only asked when the caller named a train, so the
   * usual empty result costs one extra statement rather than two.
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
