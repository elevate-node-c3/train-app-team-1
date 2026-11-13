import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { addCivilDays } from '@app/contracts';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { TimetableEntity } from '../timetables/entities/timetable.entity.js';

/**
 * ISO date strings compare lexicographically; both range ends are inclusive.
 * Null effective_until is unbounded. Ending predecessors the day before successors
 * matches the database range and leaves no gap.
 * Ignore status here so draft publication validates; pickEffectiveTimetable filters it.
 */
export function isWithinEffectiveRange(
  timetable: TimetableEntity,
  serviceDate: string,
): boolean {
  if (serviceDate < timetable.effectiveFrom) {
    return false;
  }

  return !timetable.effectiveUntil || serviceDate <= timetable.effectiveUntil;
}

/** Newest first: later `effective_from` wins, then the higher version. */
function isNewerVersion(
  candidate: TimetableEntity,
  incumbent: TimetableEntity,
): boolean {
  if (candidate.effectiveFrom !== incumbent.effectiveFrom) {
    return candidate.effectiveFrom > incumbent.effectiveFrom;
  }

  return candidate.version > incumbent.version;
}

/**
 * Share published-version selection with generation to keep date ownership consistent.
 * Ignore drafts and withdrawn rows, whose ranges may overlap a published version.
 */
export function pickEffectiveTimetable(
  timetables: TimetableEntity[],
  serviceDate: string,
): TimetableEntity | null {
  let chosen: TimetableEntity | null = null;

  for (const timetable of timetables) {
    if (timetable.status !== 'published') {
      continue;
    }
    if (!isWithinEffectiveRange(timetable, serviceDate)) {
      continue;
    }
    if (!chosen || isNewerVersion(timetable, chosen)) {
      chosen = timetable;
    }
  }

  return chosen;
}

/**
 * Compare row IDs, not effectiveFrom/version pairs, so only one version can
 * generate for a date even if rows share that pair.
 */
export function isEffectiveVersionOn(
  candidate: TimetableEntity,
  trainTimetables: TimetableEntity[],
  serviceDate: string,
): boolean {
  const effective = pickEffectiveTimetable(trainTimetables, serviceDate);

  return effective !== null && effective.id === candidate.id;
}

/** Republishing adds a row rather than replacing version history. */
@Injectable()
export class TimetableVersionService {
  constructor(
    @InjectRepository(TimetableEntity)
    private readonly timetableRepository: Repository<TimetableEntity>,
  ) {}

  private repositoryFor(manager?: EntityManager): Repository<TimetableEntity> {
    return manager?.getRepository(TimetableEntity) ?? this.timetableRepository;
  }

  /** Resolve all published history in one query, then compare dates in memory. */
  private publishedVersions(
    trainId: string,
    manager?: EntityManager,
  ): Promise<TimetableEntity[]> {
    return this.repositoryFor(manager).find({
      where: {
        train: { id: trainId },
        status: 'published',
      },
      relations: {
        train: {
          trainType: true,
        },
      },
    });
  }

  /** The version this train runs on `serviceDate`, or null if none does. */
  async effectiveOn(
    trainId: string,
    serviceDate: string,
    manager?: EntityManager,
  ): Promise<TimetableEntity | null> {
    const published = await this.publishedVersions(trainId, manager);

    return pickEffectiveTimetable(published, serviceDate);
  }

  /**
   * Include every status when choosing the next unique train/version number.
   * Return 0 with no timetable so first publication is version 1.
   */
  async latestVersionNumber(
    trainId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const newest = await this.repositoryFor(manager).findOne({
      where: {
        train: { id: trainId },
      },
      order: {
        version: 'DESC',
      },
    });

    return newest?.version ?? 0;
  }

  /**
   * Bound earlier overlapping predecessors at effectiveFrom minus one civil day,
   * before inserting the successor in the same transaction.
   * Leave same-day and future predecessors to the exclusion constraint. A same-day
   * predecessor cannot have a valid earlier end; withdraw it instead.
   */
  async supersede(
    ctx: TransactionContext,
    trainId: string,
    effectiveFrom: string,
  ): Promise<void> {
    const manager = entityManagerOf(ctx);
    const repository = this.repositoryFor(manager);
    const lastDay = addCivilDays(effectiveFrom, -1);

    const outgoing = (await this.publishedVersions(trainId, manager)).filter(
      (timetable) =>
        timetable.effectiveFrom < effectiveFrom &&
        isWithinEffectiveRange(timetable, effectiveFrom),
    );

    for (const timetable of outgoing) {
      timetable.effectiveUntil = lastDay;
      await repository.save(timetable);
    }
  }
}
