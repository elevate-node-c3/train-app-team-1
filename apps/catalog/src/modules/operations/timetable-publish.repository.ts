import { Injectable } from '@nestjs/common';
import { Between, DataSource, EntityManager, In } from 'typeorm';
import { randomUUID } from 'node:crypto';

import type {
  PublishTimetableFareInput,
  PublishTimetableStopInput,
} from '@app/contracts';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

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
 * A uuid column rejects a malformed value with `22P02` rather than "no such
 * row", so an id an operator mistyped would come back as a 500 instead of the
 * unknown-station refusal it is. Filtering to uuid shape first turns every
 * malformed id into "not in the known set", which is the honest answer.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidsOnly(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))];
}

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
   * The caller's transaction as an `EntityManager`, for the collaborators
   * that take one -- `TimetableVersionService`'s reads and `TripsService`'s.
   *
   * Unwrapping a `TransactionContext` belongs to an adapter and not to a
   * service (see `unit-of-work.port.ts`), so it happens here rather than in
   * `TimetablePublishService`. That also keeps the service's unit specs
   * honest: `entityManagerOf` only accepts a context minted by the real unit
   * of work, so a service that unwrapped for itself could not be tested
   * without a database at all.
   */
  managerOf(ctx: TransactionContext): EntityManager {
    return entityManagerOf(ctx);
  }

  /**
   * The catalogue's own answer about the ids this request named, in three
   * statements that do not grow with the route's length.
   *
   * `trainType` is loaded with the train because `TripPublished` carries it
   * and `createDatedTrip` reads it off the timetable's train.
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

    const stationIds = uuidsOnly(params.stationIds);
    const stations = stationIds.length
      ? await manager.getRepository(StationEntity).find({
          where: { id: In(stationIds) },
          select: { id: true },
        })
      : [];

    const layoutIds = uuidsOnly(params.coachLayoutIds);
    const layouts = layoutIds.length
      ? await manager
          .getRepository(CoachLayoutEntity)
          .find({ where: { id: In(layoutIds) } })
      : [];

    const classIds = uuidsOnly(params.travelClassIds);
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

  /**
   * Every published row of one train, in one query.
   *
   * One query, deliberately: `TimetableVersionService.effectiveOn` issues a
   * query per call, so anything that resolves more than one date reads the
   * rows once here and compares them in memory with the pure
   * `pickEffectiveTimetable`.
   */
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

  /** The train's published dated trips inside one civil-date range. */
  async publishedTripsBetween(
    trainId: string,
    fromDate: string,
    toDate: string,
  ): Promise<DatedTripEntity[]> {
    return this.dataSource.getRepository(DatedTripEntity).find({
      where: {
        train: { id: trainId },
        status: 'published',
        serviceDate: Between(fromDate, toDate),
      },
      order: { serviceDate: 'ASC' },
    });
  }

  /** Every stop of several trips at once, keyed by trip id, in travel order. */
  async tripStopsOf(
    tripIds: string[],
  ): Promise<Map<string, TripStopEntity[]>> {
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

  /** The new version row. Insert it only after its predecessor is bounded. */
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
      // Unbounded: this is now the live version, and the next publish bounds
      // it rather than this one guessing when it will end.
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
   * One fare row per (class, origin, destination) at this version's effective
   * instant, which is what `uq_fare_effective_version` is keyed on. A
   * republish on the same day with a corrected amount updates the row rather
   * than colliding with it; a republish on a later day adds a new row and
   * leaves the old price readable for a trip that was generated under it --
   * `resolveFareAmount` picks the newest price that had already taken effect.
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
   * Moves a dated trip onto the new version without changing its id.
   *
   * Stops are deleted and reinserted rather than patched: a stop the new
   * version drops has to disappear, and a position that moved must not leave
   * two rows claiming it (`uq_trip_stop_position`).
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

    // Gone between the diff and here -- nothing to re-point, and inventing a
    // row would resurrect a trip somebody withdrew on purpose.
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
