import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TimetableEntity } from './entities/timetable.entity.js';
import { TimetableStopEntity } from './entities/timetable-stop.entity.js';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ClsService } from 'nestjs-cls';

import { randomUUID } from 'node:crypto';

import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';

import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';

import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';

import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';

import { OUTBOX, type OutboxPort } from '@app/messaging';

import { TripsService } from '../trips/trips.service.js';
import { buildTimetablePublished } from './timetable-events.factory.js';

@Injectable()
export class TimetablesService {
  constructor(
    @InjectRepository(TimetableEntity)
    private readonly timetableRepository: Repository<TimetableEntity>,
    @Inject(UNIT_OF_WORK)
    private readonly unitOfWork: UnitOfWorkPort,

    @Inject(OUTBOX)
    private readonly outbox: OutboxPort,

    private readonly tripsService: TripsService,

    private readonly cls: ClsService,
  ) {}

  /** The ambient trace, so a publish and the trips it generates share one id. */
  private correlationId(): string {
    const ambient = this.cls.isActive()
      ? this.cls.get<string>(CORRELATION_ID_KEY)
      : null;

    return ambient || randomUUID();
  }

  async getTimetableForPublishing(
    timetableId: string,
  ): Promise<TimetableEntity | null> {
    return this.timetableRepository.findOne({
      where: {
        id: timetableId,
      },
      relations: {
        train: {
          trainType: true,
        },
      },
    });
  }

  /**
   * Seed-only publication has no operator audit entry.
   * Published effective ranges cannot overlap; seed one version per train.
   */
  async publishTimetable(timetableId: string): Promise<TimetableEntity> {
    // Validate before writing; generation runs after the commit.
    const candidate = await this.getTimetableForPublishing(timetableId);

    if (!candidate) {
      throw new NotFoundException('Timetable not found');
    }

    if (candidate.status === 'withdrawn') {
      throw new ConflictException('Timetable is withdrawn');
    }

    if (candidate.status !== 'published') {
      await this.tripsService.validateTimetableForWindow(candidate);
    }

    const publishedTimetable = await this.unitOfWork.withTransaction(
      async (ctx) => {
        const manager = entityManagerOf(ctx);

        const repository = manager.getRepository(TimetableEntity);

        const timetable = await repository.findOne({
          where: { id: timetableId },
          relations: {
            train: {
              trainType: true,
            },
          },
          lock: {
            mode: 'pessimistic_write',
          },
        });

        if (!timetable) {
          throw new NotFoundException('Timetable not found');
        }

        if (timetable.status === 'withdrawn') {
          throw new ConflictException('Timetable is withdrawn');
        }

        if (timetable.status === 'published') {
          return timetable;
        }

        timetable.status = 'published';

        const savedTimetable = await repository.save(timetable);

        // Read stops in the same transaction so they match the published route.
        const stops = await manager.getRepository(TimetableStopEntity).find({
          where: { timetable: { id: savedTimetable.id } },
          order: { position: 'ASC' },
        });

        if (stops.length < 2) {
          throw new ConflictException(
            'A timetable needs at least two stops to be published',
          );
        }

        const occurredAt = new Date();

        const event = buildTimetablePublished({
          eventId: randomUUID(),
          correlationId: this.correlationId(),
          occurredAt,
          timetableId: savedTimetable.id,
          trainId: savedTimetable.train.id,
          timetableVersion: savedTimetable.version,
          stationIdsInOrder: stops.map((stop) => stop.stationId),
        });

        await this.outbox.append(ctx, event);

        return savedTimetable;
      },
    );

    await this.tripsService.generateUpcomingTrips(publishedTimetable.id);

    return publishedTimetable;
  }
}
