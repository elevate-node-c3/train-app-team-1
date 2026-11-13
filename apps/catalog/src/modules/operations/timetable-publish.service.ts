import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import type { EntityManager } from 'typeorm';

import {
  addCivilDays,
  BOOKING_WINDOW_DAYS,
  cairoInstantOf,
  cairoToday,
  ErrorCode,
  type PublishTimetableRequest,
  type PublishTimetableResult,
  type TripSeatUsage,
  type ValidationIssueRef,
} from '@app/contracts';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging';

import { dependencyRetryAfterSeconds } from '../../config/operations-settings.js';
import type { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import type { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import type { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import type { DatedTripEntity } from '../trips/entities/dated-trip.entity.js';
import type { TripStopEntity } from '../trips/entities/trip-stop.entity.js';
import { buildTimetablePublished } from '../timetables/timetable-events.factory.js';
import { CatalogSearchError } from '../trips/catalog-search-error.js';
import { buildTripPublished } from '../trips/trip-events.factory.js';
import {
  fareKey,
  resolveStopTimes,
  type FareIndex,
} from '../trips/trip-generation.types.js';
import { TripsService } from '../trips/trips.service.js';

import {
  InventorySeatUsageClient,
  SeatUsageUnavailableError,
} from './inventory-seat-usage.grpc.client.js';
import { OperationsAuditService } from './operations-audit.service.js';
import {
  fingerprintOf,
  OperationsRequestRepository,
} from './operations-request.repository.js';
import { TimetablePublishRepository } from './timetable-publish.repository.js';
import {
  validateTimetableCandidate,
  type TimetableCandidate,
} from './timetable-publish.validator.js';
import {
  pickEffectiveTimetable,
  TimetableVersionService,
} from './timetable-version.service.js';
import type {
  PublishReferences,
  TimetableDiff,
  TimetableVersionSnapshot,
  TripChange,
} from './timetable-publish.types.js';

/** Match generation's one-day margin so counts cover every generated date. */
const PUBLISH_WINDOW_MARGIN_DAYS = 1;

/** A unique violation can indicate a reused Idempotency-Key. */
const UNIQUE_VIOLATION = '23505';

/**
 * excl_timetable_published_overlap reports same-day or out-of-order publication
 * conflicts when supersede leaves predecessors unbounded. Return a refusal,
 * not a server error.
 */
const EXCLUSION_VIOLATION = '23P01';

/** TypeORM may expose SQLSTATE on code or driverError.code. */
function hasPostgresCode(error: unknown, sqlState: string): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  };

  return (
    candidate.code === sqlState || candidate.driverError?.code === sqlState
  );
}

/** Shared data read once for each repoint pass. */
interface RepointTemplate {
  timetableStops: TimetableStopEntity[];
  capacity: number;
  compositionSnapshot: DatedTripEntity['compositionSnapshot'];
}

/** Fields used to compare a sold trip's stop shape. */
interface StopShape {
  stationId: string;
  arrivalAt: number | null;
  departureAt: number | null;
}

/**
 * Validate the whole request and get inventory usage for every affected trip before writes.
 * Commit the version, stops, fares, audit, TimetablePublished event, and
 * idempotency key in one transaction.
 * Report precommit diff counts, not generation return values.
 * Never change trips before the new effective date.
 * TimetablesService.publishTimetable is a separate seed-only path.
 */
@Injectable()
export class TimetablePublishService {
  private readonly logger = new Logger(TimetablePublishService.name);

  constructor(
    private readonly repository: TimetablePublishRepository,
    private readonly versions: TimetableVersionService,
    private readonly audit: OperationsAuditService,
    private readonly requests: OperationsRequestRepository,
    private readonly seatUsage: InventorySeatUsageClient,
    private readonly trips: TripsService,
    @Inject(UNIT_OF_WORK)
    private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX)
    private readonly outbox: OutboxPort,
    private readonly cls: ClsService,
  ) {}

  async publish(
    request: PublishTimetableRequest,
    idempotencyKey: string,
    actorAccountId: string,
  ): Promise<PublishTimetableResult> {
    const fingerprint = fingerprintOf(request);

    // Matching retries replay; reject keys reused for different content.
    const replayed = await this.replay(idempotencyKey, fingerprint);
    if (replayed) return replayed;

    const references = await this.resolveReferences(request);
    const train = references.train;

    if (!train) {
      throw this.refusal(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'trainNumber',
          rejectedValue: request.trainNumber,
          issueKey: 'ISSUE_TRAIN_NUMBER_NOT_KNOWN',
          actionKey: 'ACTION_PICK_TRAIN_FROM_LIST',
        },
      ]);
    }

    const details = [
      ...this.validateRequestShape(request),
      ...this.validateReferences(request, references),
      ...(await this.validateComposition(request, train.id)),
      ...validateTimetableCandidate(
        await this.buildCandidate(request, references, train.id),
      ),
    ];

    if (details.length > 0) {
      throw this.refusal(ErrorCode.VALIDATION_ERROR, details);
    }

    const diff = await this.computeDiff(request, train.id);

    // Never guess inventory usage.
    await this.refuseIfSeatsAreInUse(request, diff);

    const result = await this.commit({
      request,
      references,
      diff,
      idempotencyKey,
      fingerprint,
      actorAccountId,
    });

    // A null timetable means another request committed this key first; replay
    // its response and leave application of its diff to that request.
    if (result.timetable) {
      await this.applyDiff(diff, result.timetable);
    }

    return result.response;
  }

  /** The ambient trace, so a publish and the trips it causes share one id. */
  private correlationId(): string {
    const ambient = this.cls.isActive()
      ? this.cls.get<string>(CORRELATION_ID_KEY)
      : null;

    return ambient || randomUUID();
  }

  private refusal(
    code: ErrorCode,
    details: ValidationIssueRef[],
  ): CatalogSearchError {
    return new CatalogSearchError(code, details, code);
  }

  /**
   * Replay stored keys with matching fingerprints; refuse keys reused for different changes.
   */
  private async replay(
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<PublishTimetableResult | null> {
    const stored = await this.requests.find(idempotencyKey);
    if (!stored) return null;

    if (stored.fingerprint !== fingerprint) {
      throw this.refusal(ErrorCode.CONFLICT, [
        {
          field: 'Idempotency-Key',
          rejectedValue: idempotencyKey,
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REUSED',
          actionKey: 'ACTION_SEND_NEW_IDEMPOTENCY_KEY',
        },
      ]);
    }

    return JSON.parse(stored.responseJson) as PublishTimetableResult;
  }

  private resolveReferences(
    request: PublishTimetableRequest,
  ): Promise<PublishReferences> {
    const trainNumber = Number(request.trainNumber);

    return this.repository.resolveReferences({
      trainNumber: Number.isSafeInteger(trainNumber) ? trainNumber : null,
      stationIds: request.stops.map((stop) => stop.stationId),
      coachLayoutIds: request.coaches.map((coach) => coach.coachLayoutId),
      travelClassIds: [
        ...request.coaches.map((coach) => coach.travelClassId),
        ...request.fares.map((fare) => fare.travelClassId),
      ],
    });
  }

  /**
   * Validate effective date and running days here; candidate validation has no
   * request-level context.
   */
  private validateRequestShape(
    request: PublishTimetableRequest,
  ): ValidationIssueRef[] {
    const details: ValidationIssueRef[] = [];
    const today = cairoToday(new Date());

    // A new version can change the future, never already-past trips.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.effectiveFrom)) {
      details.push({
        field: 'effectiveFrom',
        rejectedValue: request.effectiveFrom,
        issueKey: 'ISSUE_CIVIL_DATE_FORMAT',
        actionKey: 'ACTION_SEND_EFFECTIVE_DATE',
      });
    } else if (request.effectiveFrom < today) {
      details.push({
        field: 'effectiveFrom',
        rejectedValue: request.effectiveFrom,
        issueKey: 'ISSUE_EFFECTIVE_DATE_IN_THE_PAST',
        actionKey: 'ACTION_PICK_EFFECTIVE_DATE_NOW_OR_LATER',
        params: { today },
      });
    }

    if (request.runningDays.length === 0) {
      details.push({
        field: 'runningDays',
        rejectedValue: request.runningDays,
        issueKey: 'ISSUE_NO_RUNNING_DAYS',
        actionKey: 'ACTION_LIST_RUNNING_WEEKDAYS',
      });
    }

    for (const day of request.runningDays) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        details.push({
          field: 'runningDays',
          rejectedValue: day,
          issueKey: 'ISSUE_WEEKDAY_OUT_OF_RANGE',
          actionKey: 'ACTION_REMOVE_OR_FIX_WEEKDAY',
        });
      }
    }

    return details;
  }

  /**
   * Candidate validation handles stations and layouts; validate travel-class IDs
   * here before resolving them.
   */
  private validateReferences(
    request: PublishTimetableRequest,
    references: PublishReferences,
  ): ValidationIssueRef[] {
    const details: ValidationIssueRef[] = [];

    request.coaches.forEach((coach, index) => {
      if (!references.knownTravelClassIds.has(coach.travelClassId)) {
        details.push({
          field: `coaches[${index}].travelClassId`,
          rejectedValue: coach.travelClassId,
          issueKey: 'ISSUE_TRAVEL_CLASS_NOT_KNOWN',
          actionKey: 'ACTION_PICK_TRAVEL_CLASS_FROM_LIST',
        });
      }
    });

    request.fares.forEach((fare, index) => {
      if (!references.knownTravelClassIds.has(fare.travelClassId)) {
        details.push({
          field: `fares[${index}].travelClassId`,
          rejectedValue: fare.travelClassId,
          issueKey: 'ISSUE_TRAVEL_CLASS_NOT_KNOWN',
          actionKey: 'ACTION_PICK_TRAVEL_CLASS_FROM_LIST',
        });
      }
    });

    return details;
  }

  /**
   * The submitted composition must be the train's actual composition.
   *
   * This is not a tidiness rule. `validateFareRules` and `validateFareFloor`
   * derive the set of travel classes to check from the coaches they are
   * handed, while `createDatedTrip` validates fares against the train's real
   * `train_coach` rows and throws a plain `Error` on a gap -- which step 7
   * swallows and logs. So a publish naming a subset of the train's classes
   * validates against that subset, commits the version, its audit entry, its
   * event and its key, reports `created: 29`, and then fails every one of
   * those 29 generations on the class it never looked at. The operator ends
   * up with a published timetable that generates nothing and a response
   * claiming otherwise.
   *
   * Refusing closes that by construction: if the two sets must be equal,
   * validation and generation cannot disagree about which classes exist.
   *
   * The alternative -- ignore `request.coaches` and build the candidate from
   * `getTrainCoaches` -- would also agree, by silently discarding a field the
   * operator submitted. A refusal they can act on is better than a success
   * that quietly ignored half their request.
   *
   * Composition changes are separate from publishing: change the train's
   * coaches first, then publish with the matching composition.
   */
  private async validateComposition(
    request: PublishTimetableRequest,
    trainId: string,
  ): Promise<ValidationIssueRef[]> {
    const actual = (await this.trips.getTrainCoaches(trainId)).map((coach) => ({
      position: coach.position,
      coachNumber: coach.coachNumber,
      travelClassId: coach.travelClass.id,
      coachLayoutId: coach.coachLayout.id,
    }));

    // Compare the four fields by value in position order, independent of request order.
    const byPosition = (
      left: { position: number },
      right: { position: number },
    ): number => left.position - right.position;

    const submitted = request.coaches
      .map((coach) => ({
        position: coach.position,
        coachNumber: coach.coachNumber,
        travelClassId: coach.travelClassId,
        coachLayoutId: coach.coachLayoutId,
      }))
      .sort(byPosition);

    const expected = [...actual].sort(byPosition);

    if (JSON.stringify(submitted) === JSON.stringify(expected)) {
      return [];
    }

    if (expected.length === 0) {
      return [
        {
          field: 'coaches',
          rejectedValue: submitted,
          issueKey: 'ISSUE_TRAIN_HAS_NO_COACHES',
          actionKey: 'ACTION_ADD_TRAIN_COACHES_BEFORE_PUBLISH',
        },
      ];
    }

    return expected.map((coach) => ({
      field: 'coaches',
      rejectedValue: submitted,
      issueKey: 'ISSUE_COACH_COMPOSITION_MISMATCH',
      actionKey: 'ACTION_SEND_CURRENT_COACH_COMPOSITION',
      params: {
        position: String(coach.position),
        coachNumber: String(coach.coachNumber),
        travelClassId: coach.travelClassId,
        coachLayoutId: coach.coachLayoutId,
      },
    }));
  }

  /**
   * Use catalog-resolved references, not request-derived IDs.
   * Overlay submitted fares on existing fares so partial corrections validate
   * against the same coverage the upsert will produce.
   */
  private async buildCandidate(
    request: PublishTimetableRequest,
    references: PublishReferences,
    trainId: string,
  ): Promise<TimetableCandidate> {
    return {
      stops: request.stops.map((stop) => ({
        stationId: stop.stationId,
        position: stop.position,
        dayOffset: stop.dayOffset,
        arrivalTime: stop.arrivalTime,
        departureTime: stop.departureTime,
      })),
      coaches: this.candidateCoaches(request, references),
      fares: await this.candidateFares(request, trainId),
      knownStationIds: references.knownStationIds,
      knownCoachLayoutIds: references.knownCoachLayoutIds,
      effectiveFrom: request.effectiveFrom,
    };
  }

  /**
   * Use empty layouts for unknown IDs so validation reports bad references
   * rather than aborting on a missing row.
   */
  private candidateCoaches(
    request: PublishTimetableRequest,
    references: PublishReferences,
  ): TrainCoachEntity[] {
    return request.coaches.map(
      (coach) =>
        ({
          id: `candidate-${coach.position}`,
          position: coach.position,
          coachNumber: coach.coachNumber,
          travelClass: references.classesById.get(coach.travelClassId) ?? {
            id: coach.travelClassId,
            nameEn: '',
            nameAr: '',
          },
          coachLayout: references.layoutsById.get(coach.coachLayoutId) ?? {
            id: coach.coachLayoutId,
            layoutName: '',
            rows: [],
          },
        }) as TrainCoachEntity,
    );
  }

  /** The train's fares as they will be once this publish's upsert lands. */
  private async candidateFares(
    request: PublishTimetableRequest,
    trainId: string,
  ): Promise<FareIndex> {
    const index = await this.trips.buildFareIndex(trainId);
    const effectiveFrom = this.fareEffectiveFrom(request.effectiveFrom);

    for (const fare of request.fares) {
      const key = fareKey(
        fare.travelClassId,
        fare.originStationId,
        fare.destinationStationId,
      );
      const prices = index.get(key) ?? [];

      // Newest first: resolveFareAmount takes the first price already in effect.
      index.set(key, [
        { effectiveFrom, amountPiastres: fare.amountPiastres },
        ...prices.filter(
          (price) => price.effectiveFrom.getTime() !== effectiveFrom.getTime(),
        ),
      ]);
    }

    return index;
  }

  /**
   * Use Cairo midnight on effectiveFrom so new fares apply from the first trip,
   * never to earlier trips.
   */
  private fareEffectiveFrom(effectiveFrom: string): Date {
    return cairoInstantOf(effectiveFrom, '00:00');
  }

  /**
   * Compare dates from max(today, effectiveFrom); earlier dates belong to the predecessor.
   * Supersession bounds the predecessor, and exclusion constraints reject any
   * remaining overlap, so every scanned date belongs to the new version.
   */
  private async computeDiff(
    request: PublishTimetableRequest,
    trainId: string,
  ): Promise<TimetableDiff> {
    const [windowStart, windowEnd] = this.publishWindow();
    const start =
      request.effectiveFrom > windowStart ? request.effectiveFrom : windowStart;

    const changes: TripChange[] = [];

    if (start > windowEnd) {
      // Generation picks up dates beyond the window as it advances.
      return { changes, created: 0, changed: 0, withdrawn: 0 };
    }

    // Withdrawn rows still own their train/date pair; they are not missing trips.
    const trips = await this.repository.tripsBetween(trainId, start, windowEnd);
    const tripsByDate = new Map(trips.map((trip) => [trip.serviceDate, trip]));
    const stopsByTrip = await this.repository.tripStopsOf(
      trips.map((trip) => trip.id),
    );

    for (
      let serviceDate = start;
      serviceDate <= windowEnd;
      serviceDate = addCivilDays(serviceDate, 1)
    ) {
      const trip = tripsByDate.get(serviceDate) ?? null;
      const runs = this.runsOn(request, serviceDate);

      if (!trip) {
        if (runs) {
          changes.push({
            serviceDate,
            kind: 'created',
            tripId: null,
            movesShape: true,
            removedStationIds: [],
          });
        }
        continue;
      }

      const withdrawn = trip.status === 'withdrawn';
      const current = (stopsByTrip.get(trip.id) ?? []).map(shapeOfTripStop);

      if (!runs) {
        // Do not count a withdrawal when the trip is already withdrawn.
        if (withdrawn) continue;

        changes.push({
          serviceDate,
          kind: 'withdrawn',
          tripId: trip.id,
          movesShape: true,
          removedStationIds: current.map((stop) => stop.stationId),
        });
        continue;
      }

      // Even identical routes change timetable ID/version in place.
      // Resurrect withdrawn rows with TripPublished so inventory recreates seats.
      // Count resurrection as changed, not created, because the trip ID survives.
      const proposed = this.proposedShape(request, serviceDate);

      changes.push({
        serviceDate,
        kind: 'changed',
        tripId: trip.id,
        // Treat resurrection as a shape change; refuse if inventory unexpectedly
        // reports seats on a withdrawn trip.
        movesShape: withdrawn || !sameShape(current, proposed),
        removedStationIds: current
          .map((stop) => stop.stationId)
          .filter(
            (stationId) =>
              !proposed.some((stop) => stop.stationId === stationId),
          ),
      });
    }

    return {
      changes,
      created: changes.filter((change) => change.kind === 'created').length,
      changed: changes.filter((change) => change.kind === 'changed').length,
      withdrawn: changes.filter((change) => change.kind === 'withdrawn').length,
    };
  }

  /**
   * Match generation: today through the one-day margin beyond search.
   * Recompute from today so downtime cannot leave gaps.
   */
  private publishWindow(): [string, string] {
    const start = cairoToday(new Date());

    return [
      start,
      addCivilDays(start, BOOKING_WINDOW_DAYS + PUBLISH_WINDOW_MARGIN_DAYS - 1),
    ];
  }

  /** Check running days only; the caller must restrict the effective range. */
  private runsOn(
    request: PublishTimetableRequest,
    serviceDate: string,
  ): boolean {
    const date = new Date(`${serviceDate}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return false;

    return request.runningDays.includes(date.getUTCDay());
  }

  private proposedShape(
    request: PublishTimetableRequest,
    serviceDate: string,
  ): StopShape[] {
    return [...request.stops]
      .sort((left, right) => left.position - right.position)
      .map((stop) => {
        const { arrivalAt, departureAt } = resolveStopTimes(
          serviceDate,
          stop.dayOffset,
          stop.arrivalTime,
          stop.departureTime,
        );

        return {
          stationId: stop.stationId,
          arrivalAt: arrivalAt?.getTime() ?? null,
          departureAt: departureAt?.getTime() ?? null,
        };
      });
  }

  /**
   * Consult inventory even with no affected trips. Missing answers are dependency
   * failures, never proof of zero tickets. Sold or held seats prohibit changed
   * stops/times and withdrawal; refusals name trips, counts, and a later effective date.
   */
  private async refuseIfSeatsAreInUse(
    request: PublishTimetableRequest,
    diff: TimetableDiff,
  ): Promise<void> {
    const affected = diff.changes.filter(
      (change): change is TripChange & { tripId: string } =>
        change.tripId !== null,
    );

    let usage: Map<string, TripSeatUsage>;

    try {
      usage = await this.seatUsage.seatUsageForTrips(
        affected.map((change) => change.tripId),
      );
    } catch (error: unknown) {
      if (!(error instanceof SeatUsageUnavailableError)) throw error;

      throw new CatalogSearchError(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        [
          {
            field: 'trainNumber',
            rejectedValue: request.trainNumber,
            issueKey: 'ISSUE_SEAT_USAGE_UNAVAILABLE',
            actionKey: 'ACTION_RETRY_PUBLISH',
            params: {
              retryAfterSeconds: String(dependencyRetryAfterSeconds()),
            },
          },
        ],
        ErrorCode.DEPENDENCY_UNAVAILABLE,
      );
    }

    const details: ValidationIssueRef[] = [];
    const laterDate = addCivilDays(
      this.publishWindow()[1],
      PUBLISH_WINDOW_MARGIN_DAYS,
    );

    for (const change of affected) {
      const seats = usage.get(change.tripId);

      // A missing trip answer is a dependency failure, never zero tickets.
      if (!seats) {
        throw new CatalogSearchError(
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          [
            {
              field: 'trainNumber',
              rejectedValue: request.trainNumber,
              issueKey: 'ISSUE_TRIP_SEAT_USAGE_UNAVAILABLE',
              actionKey: 'ACTION_RETRY_PUBLISH',
              params: {
                tripId: change.tripId,
                serviceDate: change.serviceDate,
                retryAfterSeconds: String(dependencyRetryAfterSeconds()),
              },
            },
          ],
          ErrorCode.DEPENDENCY_UNAVAILABLE,
        );
      }

      const inUse = seats.soldCount + seats.heldCount;
      if (inUse === 0) continue;

      const params = {
        tripId: change.tripId,
        serviceDate: change.serviceDate,
        soldCount: String(seats.soldCount),
        heldCount: String(seats.heldCount),
        laterDate,
      };

      if (change.kind === 'withdrawn') {
        details.push({
          field: 'runningDays',
          rejectedValue: request.runningDays,
          issueKey: 'ISSUE_PUBLISH_WOULD_WITHDRAW_IN_USE_TRIP',
          actionKey: 'ACTION_KEEP_IN_USE_WEEKDAY_OR_PUBLISH_LATER',
          params,
        });
        continue;
      }

      const stillInUse = change.removedStationIds.filter((stationId) =>
        seats.stationIdsInUse.includes(stationId),
      );

      if (stillInUse.length > 0) {
        details.push({
          field: 'stops',
          rejectedValue: stillInUse,
          issueKey: 'ISSUE_PUBLISH_WOULD_DROP_IN_USE_STOPS',
          actionKey: 'ACTION_KEEP_IN_USE_STOPS_OR_PUBLISH_LATER',
          params: { ...params, stationIds: stillInUse.join(', ') },
        });
        continue;
      }

      if (change.movesShape) {
        details.push({
          field: 'stops',
          rejectedValue: change.serviceDate,
          issueKey: 'ISSUE_PUBLISH_WOULD_CHANGE_IN_USE_TRIP',
          actionKey: 'ACTION_PUBLISH_AFTER_IN_USE_TRIPS',
          params,
        });
      }
    }

    if (details.length > 0) {
      throw this.refusal(ErrorCode.CONFLICT, details);
    }
  }

  /**
   * Commit the predecessor bound, version, stops, fares, audit, event, and replay
   * response/key atomically. A crash rolls back all of them.
   */
  private async commit(params: {
    request: PublishTimetableRequest;
    references: PublishReferences;
    diff: TimetableDiff;
    idempotencyKey: string;
    fingerprint: string;
    actorAccountId: string;
  }): Promise<{
    response: PublishTimetableResult;
    /** Null only on a replay: nothing was written, so nothing is applied. */
    timetable: TimetableEntity | null;
  }> {
    const { request, diff } = params;
    const train = params.references.train!;
    const correlationId = this.correlationId();

    try {
      return await this.unitOfWork.withTransaction(async (ctx) => {
        const manager = this.repository.managerOf(ctx);

        // Snapshot the predecessor before supersession changes it.
        const published = await this.repository.publishedVersionsOf(
          train.id,
          manager,
        );
        const predecessor = pickEffectiveTimetable(
          published,
          request.effectiveFrom,
        );
        const before = predecessor
          ? await this.snapshotOf(predecessor, manager)
          : null;

        const versionNumber =
          (await this.versions.latestVersionNumber(train.id, manager)) + 1;

        await this.versions.supersede(ctx, train.id, request.effectiveFrom);

        const timetable = await this.repository.insertVersion(ctx, {
          train,
          runningDays: request.runningDays,
          effectiveFrom: request.effectiveFrom,
          versionNumber,
        });

        await this.repository.insertStops(ctx, timetable, request.stops);

        await this.repository.upsertFares(ctx, {
          trainId: train.id,
          fares: request.fares,
          effectiveFrom: this.fareEffectiveFrom(request.effectiveFrom),
        });

        const response: PublishTimetableResult = {
          timetableId: timetable.id,
          version: versionNumber,
          created: diff.created,
          changed: diff.changed,
          withdrawn: diff.withdrawn,
        };

        await this.audit.append(ctx, {
          action: 'timetable.published',
          actorAccountId: params.actorAccountId,
          trainId: train.id,
          before,
          after: snapshotOfRequest(timetable, request),
          // No ticket tables yet; changes to trips with seats in use are refused.
          ticketsAffected: 0,
          correlationId,
        });

        await this.outbox.append(
          ctx,
          buildTimetablePublished({
            eventId: randomUUID(),
            correlationId,
            occurredAt: new Date(),
            timetableId: timetable.id,
            trainId: train.id,
            timetableVersion: versionNumber,
            stationIdsInOrder: [...request.stops]
              .sort((left, right) => left.position - right.position)
              .map((stop) => stop.stationId),
          }),
        );

        await this.requests.record(ctx, {
          idempotencyKey: params.idempotencyKey,
          fingerprint: params.fingerprint,
          responseJson: JSON.stringify(response),
        });

        return { response, timetable };
      });
    } catch (error: unknown) {
      const replay = await this.replayOrRefuse(error, params);
      if (replay) return { response: replay, timetable: null };
      throw error;
    }
  }

  /**
   * 23P01 is a published-range conflict.
   * For 23505, reread the key: only a stored matching key is a concurrent replay.
   * Other unique violations, including train/version collisions, must propagate.
   */
  private async replayOrRefuse(
    error: unknown,
    params: {
      request: PublishTimetableRequest;
      references: PublishReferences;
      idempotencyKey: string;
      fingerprint: string;
    },
  ): Promise<PublishTimetableResult | null> {
    if (hasPostgresCode(error, EXCLUSION_VIOLATION)) {
      throw this.refusal(ErrorCode.CONFLICT, await this.overlapDetails(params));
    }

    if (!hasPostgresCode(error, UNIQUE_VIOLATION)) return null;

    const stored = await this.requests.find(params.idempotencyKey);
    // Without a stored key, this is another unique violation; let the caller rethrow.
    if (!stored) return null;

    if (stored.fingerprint !== params.fingerprint) {
      throw this.refusal(ErrorCode.CONFLICT, [
        {
          field: 'Idempotency-Key',
          rejectedValue: params.idempotencyKey,
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REUSED',
          actionKey: 'ACTION_SEND_NEW_IDEMPOTENCY_KEY',
        },
      ]);
    }

    // Replay the winning request's response; this transaction wrote nothing.
    return JSON.parse(stored.responseJson) as PublishTimetableResult;
  }

  /** Names the version in the way, so the operator knows what to move past. */
  private async overlapDetails(params: {
    request: PublishTimetableRequest;
    references: PublishReferences;
  }): Promise<ValidationIssueRef[]> {
    const train = params.references.train!;
    const published = await this.repository.publishedVersionsOf(train.id);

    const clashing = published.filter(
      (timetable) =>
        !timetable.effectiveUntil ||
        timetable.effectiveUntil >= params.request.effectiveFrom,
    );

    if (clashing.length === 0) {
      return [
        {
          field: 'effectiveFrom',
          rejectedValue: params.request.effectiveFrom,
          issueKey: 'ISSUE_TIMETABLE_OVERLAPS_PUBLISHED_RANGE',
          actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
        },
      ];
    }

    return clashing.map((timetable): ValidationIssueRef => {
      if (!timetable.effectiveUntil) {
        return {
          field: 'effectiveFrom',
          rejectedValue: params.request.effectiveFrom,
          issueKey: 'ISSUE_TIMETABLE_OVERLAPS_OPEN_ENDED_VERSION',
          actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
          params: {
            version: String(timetable.version),
            effectiveFrom: timetable.effectiveFrom,
          },
        };
      }
      return {
        field: 'effectiveFrom',
        rejectedValue: params.request.effectiveFrom,
        issueKey: 'ISSUE_TIMETABLE_OVERLAPS_PUBLISHED_VERSION',
        actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
        params: {
          version: String(timetable.version),
          effectiveFrom: timetable.effectiveFrom,
          effectiveUntil: timetable.effectiveUntil,
        },
      };
    });
  }

  private async snapshotOf(
    timetable: TimetableEntity,
    manager?: EntityManager,
  ): Promise<TimetableVersionSnapshot> {
    const stops = await this.repository.stopsOf(timetable.id, manager);

    return {
      timetableId: timetable.id,
      version: timetable.version,
      effectiveFrom: timetable.effectiveFrom,
      effectiveUntil: timetable.effectiveUntil,
      runningDays: [...timetable.runningDays],
      stops: stops.map((stop) => ({
        stationId: stop.stationId,
        position: stop.position,
        dayOffset: stop.dayOffset,
        arrivalTime: stop.arrivalTime,
        departureTime: stop.departureTime,
      })),
    };
  }

  /**
   * Apply only after commit; failures cannot undo publication or block other dates.
   * The generator retries missing creations next tick. Failed withdrawals and
   * repoints are logged but have no automatic retry.
   */
  private async applyDiff(
    diff: TimetableDiff,
    timetable: TimetableEntity,
  ): Promise<void> {
    // Stops and composition are shared by every date; read them once.
    const repointTemplate = diff.changes.some(
      (change) => change.kind === 'changed',
    )
      ? await this.repointTemplate(timetable)
      : null;

    for (const change of diff.changes) {
      try {
        if (change.kind === 'created') {
          await this.trips.createDatedTrip(timetable, change.serviceDate);
        } else if (change.kind === 'changed') {
          await this.repointTrip(
            change.tripId!,
            timetable,
            change.serviceDate,
            repointTemplate!,
          );
        } else {
          await this.trips.withdrawDatedTrip(change.tripId!);
        }
      } catch (error: unknown) {
        this.logger.error(
          `Publishing timetable ${timetable.id}: could not ${change.kind} the trip on ${change.serviceDate}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Read date-independent stops and composition outside per-trip transactions. */
  private async repointTemplate(
    timetable: TimetableEntity,
  ): Promise<RepointTemplate> {
    const timetableStops = await this.trips.getTimetableStops(timetable.id);
    const coaches = await this.trips.getTrainCoaches(timetable.train.id);

    return {
      timetableStops,
      capacity: this.trips.calculateCapacity(coaches),
      compositionSnapshot: this.trips.buildCompositionSnapshot(coaches),
    };
  }

  /**
   * Keep the trip ID and emit TripPublished, which consumers upsert by ID.
   * Do not withdraw and recreate a running trip: withdrawal would destroy seats
   * travellers may hold.
   */
  private async repointTrip(
    tripId: string,
    timetable: TimetableEntity,
    serviceDate: string,
    template: RepointTemplate,
  ): Promise<void> {
    const correlationId = this.correlationId();
    const { timetableStops, capacity, compositionSnapshot } = template;

    // One transaction per trip keeps failures isolated to that date.
    await this.unitOfWork.withTransaction(async (ctx) => {
      const occurredAt = new Date();
      const tripStops = this.trips.buildTripStops(timetableStops, serviceDate);

      const trip = await this.repository.repoint(ctx, {
        tripId,
        timetable,
        compositionSnapshot,
        publishedAt: occurredAt,
        stops: tripStops,
      });

      if (!trip) return;

      await this.outbox.append(
        ctx,
        buildTripPublished({
          eventId: randomUUID(),
          correlationId,
          occurredAt,
          payload: {
            tripId: trip.id,
            trainId: timetable.train.id,
            trainNumber: timetable.train.trainNumber,
            trainType: {
              id: timetable.train.trainType.id,
              nameEn: timetable.train.trainType.nameEn,
              nameAr: timetable.train.trainType.nameAr,
            },
            serviceDate,
            timetableVersion: timetable.version,
            capacity,
            stops: tripStops.map((stop) => ({
              stationId: stop.stationId,
              position: stop.position,
              arrivalAt: stop.arrivalAt?.toISOString() ?? null,
              departureAt: stop.departureAt?.toISOString() ?? null,
            })),
            coaches: compositionSnapshot,
          },
        }),
      );
    });
  }
}

function shapeOfTripStop(stop: TripStopEntity): StopShape {
  return {
    stationId: stop.stationId,
    arrivalAt: stop.arrivalAt?.getTime() ?? null,
    departureAt: stop.departureAt?.getTime() ?? null,
  };
}

/**
 * Stations, order, and instants must all match. Even a one-minute time change
 * affects seat holders and must not be applied silently.
 */
function sameShape(left: StopShape[], right: StopShape[]): boolean {
  if (left.length !== right.length) return false;

  return left.every((stop, index) => {
    const other = right[index];

    return (
      stop.stationId === other.stationId &&
      stop.arrivalAt === other.arrivalAt &&
      stop.departureAt === other.departureAt
    );
  });
}

function snapshotOfRequest(
  timetable: TimetableEntity,
  request: PublishTimetableRequest,
): TimetableVersionSnapshot {
  return {
    timetableId: timetable.id,
    version: timetable.version,
    effectiveFrom: timetable.effectiveFrom,
    effectiveUntil: timetable.effectiveUntil,
    runningDays: [...request.runningDays],
    stops: [...request.stops]
      .sort((left, right) => left.position - right.position)
      .map((stop) => ({
        stationId: stop.stationId,
        position: stop.position,
        dayOffset: stop.dayOffset,
        arrivalTime: stop.arrivalTime,
        departureTime: stop.departureTime,
      })),
  };
}
