import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, In, LessThanOrEqual } from 'typeorm';

import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { FareEntity } from '../fares/entities/fare.entity.js';
import { StationEntity } from '../stations/entities/station.entity.js';
import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { TrainEntity } from '../trains/entities/train.entity.js';
import { TravelClassEntity } from '../trains/entities/travel-class.entity.js';
import { pickEffectiveTimetable } from './timetable-version.service.js';
import type { FareChangeReferences } from './fare-change.types.js';

/**
 * Same reasoning as `TimetablePublishRepository`'s own guard: a uuid column
 * rejects a malformed value with `22P02` rather than "no such row", so a
 * mistyped id must be filtered to uuid shape first, or an operator's typo
 * becomes a 500 instead of the unknown-reference refusal it is.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidsOnly(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))];
}

/**
 * Every read and write a fare change needs, and nothing else (TA-20).
 *
 * Mirrors `TimetablePublishRepository`'s shape for the same reason: unwrapping
 * a `TransactionContext` belongs to an adapter, never to a service, and
 * routing it through here is what lets `FareChangeService` be unit-tested
 * without a database at all.
 */
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

    const classIds = uuidsOnly([params.travelClassId]);
    const travelClass = classIds.length
      ? await manager
          .getRepository(TravelClassEntity)
          .findOne({ where: { id: classIds[0] } })
      : null;

    const stationIds = uuidsOnly(params.stationIds);
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
   * The train's real route, in travel order, for the published version
   * effective on `asOfDate`. Null when no published version covers that date
   * -- "does this pair run in order" has no honest answer without a route to
   * check it against.
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
   * The amount in effect for one (class, pair) at `asOf`, or null when none
   * has taken effect yet -- the newest row whose `effective_from` had already
   * arrived, the same reading `resolveFareAmount` gives a publish candidate.
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
   * Every existing row for this exact (train, class, pair), locked for the
   * rest of the caller's transaction. Taking this lock before reading the
   * previous amount and inserting the new row is what makes two same-second
   * operators serialise instead of interleave -- the loser's transaction
   * blocks on this call until the winner commits or rolls back.
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
        lock: { mode: 'pessimistic_write' },
      });
  }

  /** The new fare row. The previous one stays in place (CAT-2, BR-30). */
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
