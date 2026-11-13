import { Injectable } from '@nestjs/common';
import { Between, DataSource, EntityManager, In } from 'typeorm';
import { randomUUID } from 'node:crypto';

import type {
  PublishTimetableFareInput,
  PublishTimetableStopInput,
} from '@app/contracts';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { uuidShapedOnly } from '@app/common/validation/uuid.js';

import { FareEntity } from '../fares/entities/fare.entity.js';
import { CoachLayoutEntity } from '../trains/entities/coach-layout.entity.js';
import { TrainEntity } from '../trains/entities/train.entity.js';
import { TravelClassEntity } from '../trains/entities/travel-class.entity.js';
import { StationEntity } from '../stations/entities/station.entity.js';
import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { DatedTripEntity } from '../trips/entities/dated-trip.entity.js';
import { TripStopEntity } from '../trips/entities/trip-stop.entity.js';
import type { PublishReferences } from './timetable-publish.types.js';

/**
 * Every read and write a timetable publish needs, and nothing else.
 *
 * It exists so `TimetablePublishService` can be tested against an in-memory
 * store without a database and still have exactly one implementation of each
 * statement in production. `insertVersion`, `insertStops`, `upsertFares` and
 * `repoint` all take the caller's `TransactionContext` and have no overload
 * that opens their own -- the version row, its stops, the fares, the audit
 * entry, the outbox event and the idempotency key commit together or not at
 * all (BR-52, ADR-0001).
 */
@Injectable()
export class TimetablePublishRepository {
  constructor(private readonly dataSource: DataSource) {}

  private manager(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /**
   * Only adapters unwrap real TransactionContext instances; keeping this out of
   * services allows in-memory unit-of-work tests.
   */
  managerOf(ctx: TransactionContext): EntityManager {
    return entityManagerOf(ctx);
  }

  /**
   * Batch requested references without per-stop queries; load trainType for
   * TripPublished and generation.
   */
  async resolveReferences(params: {
    trainNumber: number | null;
    stationIds: string[];
    coachLayoutIds: string[];
    travelClassIds: string[];
  }): Promise<PublishReferences> {
    const manager = this.manager();

    const train =
      params.trainNumber === null
        ? null
        : await manager.getRepository(TrainEntity).findOne({
            where: { trainNumber: params.trainNumber },
            relations: { trainType: true },
          });

    /**
     * A uuid column rejects a malformed value with `22P02` rather than "no such
     * row", so an id an operator mistyped would come back as a 500 instead of the
     * unknown-station refusal it is. Filtering to uuid shape first turns every
     * malformed id into "not in the known set", which is the honest answer.
     */
    const stationIds = uuidShapedOnly(params.stationIds);
    const stations = stationIds.length
      ? await manager.getRepository(StationEntity).find({
          where: { id: In(stationIds) },
          select: { id: true },
        })
      : [];

    const layoutIds = uuidShapedOnly(params.coachLayoutIds);
    const layouts = layoutIds.length
      ? await manager
          .getRepository(CoachLayoutEntity)
          .find({ where: { id: In(layoutIds) } })
      : [];

    const classIds = uuidShapedOnly(params.travelClassIds);
    const classes = classIds.length
      ? await manager
          .getRepository(TravelClassEntity)
          .find({ where: { id: In(classIds) } })
      : [];

    return {
      train,
      knownStationIds: new Set(stations.map((station) => station.id)),
      knownCoachLayoutIds: new Set(layouts.map((layout) => layout.id)),
      knownTravelClassIds: new Set(
        classes.map((travelClass) => travelClass.id),
      ),
      layoutsById: new Map(layouts.map((layout) => [layout.id, layout])),
      classesById: new Map(
        classes.map((travelClass) => [travelClass.id, travelClass]),
      ),
    };
  }

  /** Read published versions once; resolve multiple dates in memory. */
  async publishedVersionsOf(
    trainId: string,
    manager?: EntityManager,
  ): Promise<TimetableEntity[]> {
    return this.manager(manager)
      .getRepository(TimetableEntity)
      .find({
        where: { train: { id: trainId }, status: 'published' },
        relations: { train: { trainType: true } },
      });
  }

  async stopsOf(
    timetableId: string,
    manager?: EntityManager,
  ): Promise<TimetableStopEntity[]> {
    return this.manager(manager)
      .getRepository(TimetableStopEntity)
      .find({
        where: { timetable: { id: timetableId } },
        relations: { station: true },
        order: { position: 'ASC' },
      });
  }

  /**
   * Include all statuses: withdrawn rows still own the unique train/date pair.
   * Treating them as missing would count a creation but leave the row withdrawn,
   * without TripPublished to recreate inventory seats.
   */
  async tripsBetween(
    trainId: string,
    fromDate: string,
    toDate: string,
  ): Promise<DatedTripEntity[]> {
    return this.dataSource.getRepository(DatedTripEntity).find({
      where: {
        train: { id: trainId },
        serviceDate: Between(fromDate, toDate),
      },
      order: { serviceDate: 'ASC' },
    });
  }

  /** Every stop of several trips at once, keyed by trip id, in travel order. */
  async tripStopsOf(tripIds: string[]): Promise<Map<string, TripStopEntity[]>> {
    const byTrip = new Map<string, TripStopEntity[]>();
    if (tripIds.length === 0) return byTrip;

    const stops = await this.dataSource.getRepository(TripStopEntity).find({
      where: { trip: { id: In(tripIds) } },
      relations: { trip: true },
      order: { position: 'ASC' },
    });

    for (const stop of stops) {
      const existing = byTrip.get(stop.trip.id);
      if (existing) existing.push(stop);
      else byTrip.set(stop.trip.id, [stop]);
    }

    return byTrip;
  }

  /** Bound the predecessor before inserting the new version. */
  async insertVersion(
    ctx: TransactionContext,
    version: {
      train: TrainEntity;
      runningDays: number[];
      effectiveFrom: string;
      versionNumber: number;
    },
  ): Promise<TimetableEntity> {
    const repository = entityManagerOf(ctx).getRepository(TimetableEntity);

    const row = repository.create({
      id: randomUUID(),
      train: version.train,
      runningDays: version.runningDays,
      effectiveFrom: version.effectiveFrom,
      // Leave the live version unbounded; the next publication sets its end.
      effectiveUntil: null,
      version: version.versionNumber,
      status: 'published',
    });

    return repository.save(row);
  }

  async insertStops(
    ctx: TransactionContext,
    timetable: TimetableEntity,
    stops: PublishTimetableStopInput[],
  ): Promise<TimetableStopEntity[]> {
    const repository = entityManagerOf(ctx).getRepository(TimetableStopEntity);

    return repository.save(
      stops.map((stop) =>
        repository.create({
          id: randomUUID(),
          timetable,
          stationId: stop.stationId,
          position: stop.position,
          dayOffset: stop.dayOffset,
          arrivalTime: stop.arrivalTime,
          departureTime: stop.departureTime,
        }),
      ),
    );
  }

  /**
   * Key fare versions by train, class, pair, and effective instant.
   * Same-day corrections update; later dates append so earlier trips retain prices.
   * Resolve the newest price already in effect.
   */
  async upsertFares(
    ctx: TransactionContext,
    params: {
      trainId: string;
      fares: PublishTimetableFareInput[];
      effectiveFrom: Date;
    },
  ): Promise<void> {
    if (params.fares.length === 0) return;

    const repository = entityManagerOf(ctx).getRepository(FareEntity);

    await repository.upsert(
      params.fares.map((fare) => ({
        id: randomUUID(),
        train: { id: params.trainId },
        travelClass: { id: fare.travelClassId },
        originStationId: fare.originStationId,
        destinationStationId: fare.destinationStationId,
        amountPiastres: fare.amountPiastres,
        effectiveFrom: params.effectiveFrom,
      })),
      {
        conflictPaths: [
          'train',
          'travelClass',
          'originStationId',
          'destinationStationId',
          'effectiveFrom',
        ],
        skipUpdateIfNoValuesChanged: true,
      },
    );
  }

  /**
   * Keep the trip ID; replace stops so dropped stations disappear and moved
   * positions do not conflict with uq_trip_stop_position.
   */
  async repoint(
    ctx: TransactionContext,
    params: {
      tripId: string;
      timetable: TimetableEntity;
      compositionSnapshot: DatedTripEntity['compositionSnapshot'];
      publishedAt: Date;
      stops: {
        station: TripStopEntity['station'];
        stationId: string;
        position: number;
        arrivalAt: Date | null;
        departureAt: Date | null;
      }[];
    },
  ): Promise<DatedTripEntity | null> {
    const manager = entityManagerOf(ctx);
    const tripRepository = manager.getRepository(DatedTripEntity);

    const trip = await tripRepository.findOne({
      where: { id: params.tripId },
      lock: { mode: 'pessimistic_write' },
    });

    // Do not recreate a trip removed after the diff was computed.
    if (!trip) return null;

    trip.timetable = params.timetable;
    trip.timetableVersion = params.timetable.version;
    trip.compositionSnapshot = params.compositionSnapshot;
    trip.status = 'published';
    trip.publishedAt = params.publishedAt;

    const saved = await tripRepository.save(trip);

    const stopRepository = manager.getRepository(TripStopEntity);
    await stopRepository.delete({ trip: { id: params.tripId } });
    await stopRepository.save(
      params.stops.map((stop) =>
        stopRepository.create({
          id: randomUUID(),
          trip: saved,
          station: stop.station,
          stationId: stop.stationId,
          position: stop.position,
          arrivalAt: stop.arrivalAt,
          departureAt: stop.departureAt,
        }),
      ),
    );

    return saved;
  }
}
