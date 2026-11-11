import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { addCivilDays } from '@app/contracts';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { TimetableEntity } from '../timetables/entities/timetable.entity.js';

/**
 * Does this version apply on this civil day?
 *
 * Both ends are inclusive: `effective_until` is the *last* day the version
 * applies, and null means it is still live. The exclusion constraint added in
 * 1793300000006 reads the row the same way -- `daterange(effective_from,
 * effective_until, '[]')` -- and {@link TimetableVersionService.supersede}
 * bounds a predecessor at the day *before* its successor takes effect, which
 * leaves no gap only because the end is included.
 *
 * ISO dates compare lexicographically, which is what lets a civil date stay a
 * string here, as the generator already relies on.
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
 * The one version of a train that applies on `serviceDate`, out of all of its
 * published rows.
 *
 * Pure, and shared with trip generation on purpose: generation resolving a
 * service date one way while a publish resolved it another is the whole bug
 * class this task exists to close.
 */
export function pickEffectiveTimetable(
  timetables: TimetableEntity[],
  serviceDate: string,
): TimetableEntity | null {
  let chosen: TimetableEntity | null = null;

  for (const timetable of timetables) {
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
 * Is `candidate` the version its train runs on `serviceDate`?
 *
 * Compares `(effective_from, version)` rather than the row's id, because that
 * pair *is* a version's identity: `uq_timetable_train_version` makes the
 * version unique per train, so no two published rows of one train can answer
 * true for the same date. Generation asks this per date instead of trusting
 * every published row it was handed.
 */
export function isEffectiveVersionOn(
  candidate: TimetableEntity,
  trainTimetables: TimetableEntity[],
  serviceDate: string,
): boolean {
  const effective = pickEffectiveTimetable(trainTimetables, serviceDate);

  return (
    effective !== null &&
    effective.effectiveFrom === candidate.effectiveFrom &&
    effective.version === candidate.version
  );
}

/**
 * Timetable versions accumulate: a republish adds a row, it never rewrites
 * one. This service owns the three questions that follow from that -- which
 * version a given day belongs to, what the next version number is, and how to
 * bound the version a new one replaces.
 */
@Injectable()
export class TimetableVersionService {
  constructor(
    @InjectRepository(TimetableEntity)
    private readonly timetableRepository: Repository<TimetableEntity>,
  ) {}

  private repositoryFor(manager?: EntityManager): Repository<TimetableEntity> {
    return manager?.getRepository(TimetableEntity) ?? this.timetableRepository;
  }

  /**
   * Every published row of one train -- the live version and whatever history
   * is still marked published. A train carries a handful of these, so they are
   * resolved in one query and compared in memory rather than asked for per
   * date.
   */
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
   * The highest version number this train has ever carried, in any status, so
   * `latest + 1` is free of `uq_timetable_train_version` -- which does not care
   * whether the row it collides with was withdrawn. 0 for a train with no
   * timetable, so the first publish is version 1.
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
   * Bounds the version a publish effective on `effectiveFrom` replaces, at the
   * civil day before it. Call it before inserting the successor, inside the
   * same transaction, or the exclusion constraint rejects the insert.
   *
   * Only a version that started *earlier* and still reaches `effectiveFrom` is
   * bounded. Two cases are deliberately left to the constraint rather than
   * patched over here: a published row that starts on `effectiveFrom` itself
   * (nothing valid to bound it to -- `chk_timetable_dates` forbids an
   * `effective_until` before `effective_from`, so that republish has to
   * withdraw the row instead), and one that starts after it. Both fail loudly
   * at insert instead of quietly producing a range this service's own reading
   * would disagree with.
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
