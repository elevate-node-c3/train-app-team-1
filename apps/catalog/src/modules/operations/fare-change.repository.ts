import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, In, LessThanOrEqual } from 'typeorm';

import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { uuidShapedOnly } from '@app/common/validation/uuid.js';

import { FareEntity } from '../fares/entities/fare.entity.js';
import { StationEntity } from '../stations/entities/station.entity.js';
import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { TrainEntity } from '../trains/entities/train.entity.js';
import { TravelClassEntity } from '../trains/entities/travel-class.entity.js';
import { pickEffectiveTimetable } from './timetable-version.service.js';
import type { FareChangeReferences } from './fare-change.types.js';

/** Every read and write a fare change needs, and nothing else (TA-20). */
@Injectable()
export class FareChangeRepository {
  constructor(private readonly dataSource: DataSource) {}

  managerOf(ctx: TransactionContext) {
    return entityManagerOf(ctx);
  }

  async resolveReferences(params: {
    trainNumber: number | null;
    travelClassId: string;
    stationIds: string[];
  }): Promise<FareChangeReferences> {
    const manager = this.dataSource.manager;

    const train =
      params.trainNumber === null
        ? null
        : await manager
            .getRepository(TrainEntity)
            .findOne({ where: { trainNumber: params.trainNumber } });

    /**
     * A UUID column rejects a malformed id with `22P02`, so filter to UUID shape
     * first or a typo becomes a 500 instead of an unknown-reference refusal.
     */
    const classIds = uuidShapedOnly([params.travelClassId]);
    const travelClass = classIds.length
      ? await manager
          .getRepository(TravelClassEntity)
          .findOne({ where: { id: classIds[0] } })
      : null;

    const stationIds = uuidShapedOnly(params.stationIds);
    const stations = stationIds.length
      ? await manager.getRepository(StationEntity).find({
          where: { id: In(stationIds) },
          select: { id: true },
        })
      : [];

    return {
      train,
      travelClass,
      knownStationIds: new Set(stations.map((station) => station.id)),
    };
  }

  /**
   * The route in travel order for the version effective on `asOfDate`, or null
   * when no published version covers it.
   */
  async routeStationOrder(
    trainId: string,
    asOfDate: string,
  ): Promise<string[] | null> {
    const manager = this.dataSource.manager;

    const published = await manager.getRepository(TimetableEntity).find({
      where: { train: { id: trainId }, status: 'published' },
    });

    const effective = pickEffectiveTimetable(published, asOfDate);
    if (!effective) return null;

    const stops = await manager.getRepository(TimetableStopEntity).find({
      where: { timetable: { id: effective.id } },
      order: { position: 'ASC' },
    });

    return stops.map((stop) => stop.stationId);
  }

  /**
   * The newest amount already in effect at `asOf`, or null when none has taken
   * effect yet.
   */
  async fareAmountAsOf(params: {
    trainId: string;
    travelClassId: string;
    originStationId: string;
    destinationStationId: string;
    asOf: Date;
  }): Promise<number | null> {
    const row = await this.dataSource.getRepository(FareEntity).findOne({
      where: {
        train: { id: params.trainId },
        travelClass: { id: params.travelClassId },
        originStationId: params.originStationId,
        destinationStationId: params.destinationStationId,
        effectiveFrom: LessThanOrEqual(params.asOf),
      },
      order: { effectiveFrom: 'DESC' },
    });

    return row?.amountPiastres ?? null;
  }

  /**
   * Locks this (train, class, pair) for the rest of the transaction. `tables:
   * ['fare']` is load-bearing: a bare `pessimistic_write` also locks the joined
   * `train` row and deadlocks against publish's `FOR KEY SHARE`.
   */
  async lockFareHistory(
    ctx: TransactionContext,
    params: {
      trainId: string;
      travelClassId: string;
      originStationId: string;
      destinationStationId: string;
    },
  ): Promise<FareEntity[]> {
    return entityManagerOf(ctx)
      .getRepository(FareEntity)
      .find({
        where: {
          train: { id: params.trainId },
          travelClass: { id: params.travelClassId },
          originStationId: params.originStationId,
          destinationStationId: params.destinationStationId,
        },
        order: { effectiveFrom: 'DESC' },
        lock: { mode: 'pessimistic_write', tables: ['fare'] },
      });
  }

  /** The new fare row; the previous one stays (CAT-2, BR-30). */
  async insertFare(
    ctx: TransactionContext,
    params: {
      trainId: string;
      travelClassId: string;
      originStationId: string;
      destinationStationId: string;
      amountPiastres: number;
      effectiveFrom: Date;
    },
  ): Promise<FareEntity> {
    const repository = entityManagerOf(ctx).getRepository(FareEntity);

    const row = repository.create({
      id: randomUUID(),
      train: { id: params.trainId } as TrainEntity,
      travelClass: { id: params.travelClassId } as TravelClassEntity,
      originStationId: params.originStationId,
      destinationStationId: params.destinationStationId,
      amountPiastres: params.amountPiastres,
      effectiveFrom: params.effectiveFrom,
    });

    return repository.save(row);
  }
}
