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
  type ValidationErrorDetail,
} from '@app/contracts';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging';

import type { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import type { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import type { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
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

/**
 * One day past what search offers, matching `TripsService`'s own margin: the
 * diff has to cover every date generation will produce, or a publish would
 * report fewer trips than it causes.
 */
const PUBLISH_WINDOW_MARGIN_DAYS = 1;

/** How long a client should wait before retrying a publish inventory blocked. */
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

/** A unique violation -- here, a reused `Idempotency-Key`. */
const UNIQUE_VIOLATION = '23505';

/**
 * An exclusion-constraint violation: `excl_timetable_published_overlap`.
 *
 * `TimetableVersionService.supersede` deliberately does not bound a published
 * predecessor whose `effective_from` is on or after the new one's -- a
 * same-day republish, or a publish behind an already-published future version
 * -- so those arrive here as a raw Postgres code. Nothing else in this
 * codebase matches `23P01`, and without this an operator would get a 500 for
 * a legitimate conflict.
 */
const EXCLUSION_VIOLATION = '23P01';

/**
 * Both `code` and `driverError.code`, because TypeORM wraps the driver's
 * error and which of the two carries the SQLSTATE depends on where the
 * failure was raised. Same shape as `trips.service.ts`'s `isUniqueViolation`.
 */
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

/** A stop, reduced to what "the same shape" means for a sold trip. */
interface StopShape {
  stationId: string;
  arrivalAt: number | null;
  departureAt: number | null;
}

/**
 * Publishing a whole timetable for one train, in one call (TA-20).
 *
 * The governing rule, from which every refusal below follows: a published
 * timetable is a promise someone may already have bought. The publish may
 * change the future and must never rewrite the past. So:
 *
 *   * nothing is written until the request validates *as a whole* and
 *     inventory has answered about every trip the publish would touch;
 *   * the version row, its stops, the fares, the audit entry, the
 *     `TimetablePublished` event and the idempotency key commit in **one**
 *     transaction, or none of them exist;
 *   * the counts the operator is told come from the diff computed before the
 *     commit, never from what the generation pass happened to insert;
 *   * no dated trip before the new effective date is touched at all.
 *
 * `TimetablesService.publishTimetable` is the *seeding* path and does
 * something different on purpose -- see its doc comment.
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

  /**
   * The eight steps in `§6.2`'s order. It is "validate whole, then write", and
   * the order is the design: steps 1-5 read and refuse, step 6 is the single
   * transaction, and step 7 only ever runs against a committed version.
   */
  async publish(
    request: PublishTimetableRequest,
    idempotencyKey: string,
    actorAccountId: string,
  ): Promise<PublishTimetableResult> {
    const fingerprint = fingerprintOf(request);

    // 1. A genuine retry gets the first answer back; a reused key on
    //    different content is a client bug, not a replay.
    const replayed = await this.replay(idempotencyKey, fingerprint);
    if (replayed) return replayed;

    // 2. What the catalogue actually holds for the ids this request named.
    const references = await this.resolveReferences(request);
    const train = references.train;

    if (!train) {
      throw this.refusal(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'trainNumber',
          rejectedValue: request.trainNumber,
          issue: 'is not a known train number',
          action: 'Choose a train number from the train list',
        },
      ]);
    }

    // 3. Every problem in one answer. A fault on stop 14 of 15 must not hide
    //    the other four.
    const details = [
      ...this.validateRequestShape(request),
      ...this.validateReferences(request, references),
      ...validateTimetableCandidate(
        await this.buildCandidate(request, references, train.id),
      ),
    ];

    if (details.length > 0) {
      throw this.refusal(ErrorCode.VALIDATION_ERROR, details);
    }

    // 4. What the publish would do, before it does any of it.
    const diff = await this.computeDiff(request, train.id);

    // 5. The one question a publish must never guess at.
    await this.refuseIfSeatsAreInUse(request, diff);

    // 6. One transaction.
    const result = await this.commit({
      request,
      references,
      diff,
      idempotencyKey,
      fingerprint,
      actorAccountId,
    });

    // 7/8. Apply the committed version, and answer with step 4's counts. A
    // null timetable means a concurrent publish of the same key committed
    // first: its answer is the answer, and it applies its own diff.
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
    details: ValidationErrorDetail[],
  ): CatalogSearchError {
    return new CatalogSearchError(code, details, code);
  }

  /**
   * Step 1. A stored key with a matching fingerprint replays; a stored key
   * with a different fingerprint is refused, because the client has reused a
   * key for a different change and silently applying it would be worse than
   * either answer.
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
          issue: 'has already been used for a different publish',
          action: 'Send a new Idempotency-Key for a different request body',
        },
      ]);
    }

    return JSON.parse(stored.responseJson) as PublishTimetableResult;
  }

  /** Step 2. */
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
   * The two things only this service can judge: when the version takes
   * effect, and which days it runs. Both are refusals the shared validator
   * deliberately knows nothing about -- it validates a candidate, not a
   * request.
   */
  private validateRequestShape(
    request: PublishTimetableRequest,
  ): ValidationErrorDetail[] {
    const details: ValidationErrorDetail[] = [];
    const today = cairoToday(new Date());

    // The whole point of versioning: a publish changes the future. A date
    // already past has trips somebody may have bought, and rewriting them is
    // exactly what this service exists to prevent.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.effectiveFrom)) {
      details.push({
        field: 'effectiveFrom',
        rejectedValue: request.effectiveFrom,
        issue: 'is not a civil date in YYYY-MM-DD form',
        action: 'Send the effective date as YYYY-MM-DD',
      });
    } else if (request.effectiveFrom < today) {
      details.push({
        field: 'effectiveFrom',
        rejectedValue: request.effectiveFrom,
        issue: `is in the past (today in Cairo is ${today})`,
        action: `Choose an effective date of ${today} or later`,
      });
    }

    if (request.runningDays.length === 0) {
      details.push({
        field: 'runningDays',
        rejectedValue: request.runningDays,
        issue: 'names no day the train runs',
        action: 'List at least one weekday, 0 for Sunday through 6 for Saturday',
      });
    }

    for (const day of request.runningDays) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        details.push({
          field: 'runningDays',
          rejectedValue: day,
          issue: 'is not a weekday between 0 (Sunday) and 6 (Saturday)',
          action: 'Remove the value or replace it with a weekday from 0 to 6',
        });
      }
    }

    return details;
  }

  /**
   * The ids the shared validator does not cover. It is handed the real
   * station and layout sets and reports those itself; travel classes it never
   * sees, because a candidate carries resolved classes rather than ids.
   */
  private validateReferences(
    request: PublishTimetableRequest,
    references: PublishReferences,
  ): ValidationErrorDetail[] {
    const details: ValidationErrorDetail[] = [];

    request.coaches.forEach((coach, index) => {
      if (!references.knownTravelClassIds.has(coach.travelClassId)) {
        details.push({
          field: `coaches[${index}].travelClassId`,
          rejectedValue: coach.travelClassId,
          issue: 'is not a known travel class',
          action: 'Choose a travel class from the travel class list',
        });
      }
    });

    request.fares.forEach((fare, index) => {
      if (!references.knownTravelClassIds.has(fare.travelClassId)) {
        details.push({
          field: `fares[${index}].travelClassId`,
          rejectedValue: fare.travelClassId,
          issue: 'is not a known travel class',
          action: 'Choose a travel class from the travel class list',
        });
      }
    });

    return details;
  }

  /**
   * Step 3's input.
   *
   * Two things worth stating. The known-reference sets are the **real** ones
   * from the catalogue, not sets derived from the request -- generation's
   * permissive pattern is right for generation, whose rows are already
   * FK-constrained, and would make the unknown-station and unknown-layout
   * rules validate nothing here.
   *
   * And the fare index is the train's existing fares with this request's
   * layered over them, which is what the table will look like after the
   * upsert. Validating against the submitted fares alone would refuse a
   * publish that only corrects one segment of an otherwise complete table.
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
   * The submitted composition, resolved against the catalogue. A coach naming
   * a layout that does not exist still becomes a candidate coach -- with an
   * empty layout -- so `validateCapacityIssues` can report it as unknown
   * rather than the whole publish failing on a missing row.
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

      // Newest first, as `buildFareIndex` leaves it: `resolveFareAmount`
      // takes the first price that had already taken effect.
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
   * Midnight in Cairo on the version's first day. A stop's departure on that
   * day is at or after it, so the new price resolves for the first trip the
   * version generates and not for any trip before it.
   */
  private fareEffectiveFrom(effectiveFrom: string): Date {
    return cairoInstantOf(effectiveFrom, '00:00');
  }

  /**
   * Step 4. What each service date in the booking window gains, keeps or
   * loses.
   *
   * The scan starts at the later of today and the effective date, which is
   * what "never rewrites the past" means concretely: a date before the new
   * version takes effect still belongs to its predecessor and is not looked
   * at. From the effective date on, every date in the window belongs to the
   * new version -- `supersede` bounds the predecessor and
   * `excl_timetable_published_overlap` refuses the insert if any other
   * published row still claims one of those days, so this is a database fact
   * rather than an assumption.
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
      // The version takes effect beyond the booking window: nothing to do
      // now, and generation will pick it up as the window rolls forward.
      return { changes, created: 0, changed: 0, withdrawn: 0 };
    }

    const trips = await this.repository.publishedTripsBetween(
      trainId,
      start,
      windowEnd,
    );
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

      const current = (stopsByTrip.get(trip.id) ?? []).map(shapeOfTripStop);

      if (!runs) {
        changes.push({
          serviceDate,
          kind: 'withdrawn',
          tripId: trip.id,
          movesShape: true,
          removedStationIds: current.map((stop) => stop.stationId),
        });
        continue;
      }

      // Re-pointed in place. Even an identical route is a change: the trip's
      // `timetable_id` and `timetable_version` move to the new row, or it
      // would keep naming a version that has been superseded.
      const proposed = this.proposedShape(request, serviceDate);

      changes.push({
        serviceDate,
        kind: 'changed',
        tripId: trip.id,
        movesShape: !sameShape(current, proposed),
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
   * The same window generation uses, restated rather than reached for: it is
   * one day past what search offers, always from today so a job that was down
   * for three days still fills the gap it left.
   */
  private publishWindow(): [string, string] {
    const start = cairoToday(new Date());

    return [
      start,
      addCivilDays(start, BOOKING_WINDOW_DAYS + PUBLISH_WINDOW_MARGIN_DAYS - 1),
    ];
  }

  /**
   * Running days only. Whether the date is inside the version's effective
   * range is the caller's question, and `computeDiff` has already answered it
   * by starting its scan at the effective date.
   */
  private runsOn(
    request: PublishTimetableRequest,
    serviceDate: string,
  ): boolean {
    const date = new Date(`${serviceDate}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return false;

    return request.runningDays.includes(date.getUTCDay());
  }

  /** The route this request would give one service date, as instants. */
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
   * Step 5. §6.2: a dated trip with sold or held seats may not have its times
   * or its stop set rewritten, and may not be withdrawn. The operator is told
   * which trips and how many seats, and offered the one thing that does work
   * -- a later effective date.
   *
   * The seam is consulted on **every** publish, including one with no
   * affected trip. `SeatUsageUnavailableError` means the question was not
   * answered, and a publish that proceeded on an unanswered question would be
   * treating silence as "no tickets" -- the exact failure the seam exists to
   * prevent. An empty ask is the cheapest confirmation inventory can still
   * answer at all.
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
            issue:
              'inventory could not say whether the affected trips have sold or held seats',
            action: `Retry the publish with the same Idempotency-Key in about ${DEPENDENCY_RETRY_AFTER_SECONDS} seconds`,
          },
        ],
        ErrorCode.DEPENDENCY_UNAVAILABLE,
      );
    }

    const details: ValidationErrorDetail[] = [];
    const laterDate = addCivilDays(
      this.publishWindow()[1],
      PUBLISH_WINDOW_MARGIN_DAYS,
    );

    for (const change of affected) {
      const seats = usage.get(change.tripId);

      // The client maps every requested id, so a gap is a broken inventory
      // rather than a zero. Never read an absent answer as "no tickets".
      if (!seats) {
        throw new CatalogSearchError(
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          [
            {
              field: 'trainNumber',
              rejectedValue: request.trainNumber,
              issue: `inventory did not answer for trip ${change.tripId} on ${change.serviceDate}`,
              action: `Retry the publish with the same Idempotency-Key in about ${DEPENDENCY_RETRY_AFTER_SECONDS} seconds`,
            },
          ],
          ErrorCode.DEPENDENCY_UNAVAILABLE,
        );
      }

      const inUse = seats.soldCount + seats.heldCount;
      if (inUse === 0) continue;

      const counts = `${seats.soldCount} sold and ${seats.heldCount} held seat(s)`;

      if (change.kind === 'withdrawn') {
        details.push({
          field: 'runningDays',
          rejectedValue: request.runningDays,
          issue: `trip ${change.tripId} on ${change.serviceDate} has ${counts}, and these running days would withdraw it`,
          action: `Keep that weekday, or republish with an effectiveFrom of ${laterDate} or later`,
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
          issue: `trip ${change.tripId} on ${change.serviceDate} has ${counts} boarding or alighting at ${stillInUse.join(', ')}, and this route drops those stops`,
          action: `Keep those stops, or republish with an effectiveFrom of ${laterDate} or later`,
        });
        continue;
      }

      if (change.movesShape) {
        details.push({
          field: 'stops',
          rejectedValue: change.serviceDate,
          issue: `trip ${change.tripId} on ${change.serviceDate} has ${counts}, and this publish would change its stops or times`,
          action: `Republish with an effectiveFrom of ${laterDate} or later, so the change only reaches trips nobody has bought`,
        });
      }
    }

    if (details.length > 0) {
      throw this.refusal(ErrorCode.CONFLICT, details);
    }
  }

  /**
   * Step 6. The single transaction.
   *
   * Everything that makes the publish a fact goes in here together: the
   * version row and its stops, the fares, the predecessor's new upper bound,
   * the BR-52 audit entry, the `TimetablePublished` event and the idempotency
   * key with the response the operator will be given. A crash anywhere inside
   * leaves none of the six, so a retry is a clean retry.
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

        // Read before `supersede` rewrites it: the audit's `before` is the
        // predecessor as it stood, not as this publish left it.
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
          // 0 this sprint: inventory has no ticket tables yet, and any trip
          // with seats in use was refused in step 5.
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
   * The two Postgres refusals a legitimate publish can earn, and nothing
   * else.
   *
   * `23P01` is the exclusion constraint: another published version of this
   * train already claims a day in the new range. `supersede` leaves that case
   * alone on purpose -- it has nothing valid to bound a same-day predecessor
   * to -- so it has to be answered here or the operator sees a 500.
   *
   * `23505` is a reused `Idempotency-Key`: `record` inserts rather than
   * saves, so a concurrent publish that committed the same key first fails
   * this transaction instead of overwriting its answer. Re-reading the key is
   * what tells that race apart from any other unique violation -- a collision
   * on `uq_timetable_train_version`, say, leaves no row to find and is
   * rethrown untouched.
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
      throw this.refusal(ErrorCode.CONFLICT, [
        {
          field: 'effectiveFrom',
          rejectedValue: params.request.effectiveFrom,
          issue: await this.describeOverlap(params),
          action:
            'Choose an effective date after the clashing version, or withdraw that version first',
        },
      ]);
    }

    if (!hasPostgresCode(error, UNIQUE_VIOLATION)) return null;

    const stored = await this.requests.find(params.idempotencyKey);
    // No stored key: the violation came from somewhere else -- a collision on
    // `uq_timetable_train_version`, say -- and must not be dressed up as a
    // replay. The caller rethrows.
    if (!stored) return null;

    if (stored.fingerprint !== params.fingerprint) {
      throw this.refusal(ErrorCode.CONFLICT, [
        {
          field: 'Idempotency-Key',
          rejectedValue: params.idempotencyKey,
          issue: 'has already been used for a different publish',
          action: 'Send a new Idempotency-Key for a different request body',
        },
      ]);
    }

    // A concurrent publish of the same request won the race. Its answer is
    // the answer -- this transaction wrote nothing at all.
    return JSON.parse(stored.responseJson) as PublishTimetableResult;
  }

  /** Names the version in the way, so the operator knows what to move past. */
  private async describeOverlap(params: {
    request: PublishTimetableRequest;
    references: PublishReferences;
  }): Promise<string> {
    const train = params.references.train!;
    const published = await this.repository.publishedVersionsOf(train.id);

    const clashing = published.filter(
      (timetable) =>
        !timetable.effectiveUntil ||
        timetable.effectiveUntil >= params.request.effectiveFrom,
    );

    if (clashing.length === 0) {
      return 'overlaps a published version of this train';
    }

    return `overlaps published version(s) ${clashing
      .map(
        (timetable) =>
          `${timetable.version} (${timetable.effectiveFrom} to ${
            timetable.effectiveUntil ?? 'open-ended'
          })`,
      )
      .join(', ')} of this train`;
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
   * Step 7. Applies the committed version to the dated trips.
   *
   * One failure must not cost the other dates theirs, and none of it can undo
   * the commit: the version is published, the operator already has the
   * counts, and the generation loop fills in any date this pass missed on its
   * next tick. A withdrawal or a re-point that failed here is logged loudly
   * because nothing else will retry it.
   */
  private async applyDiff(
    diff: TimetableDiff,
    timetable: TimetableEntity,
  ): Promise<void> {
    for (const change of diff.changes) {
      try {
        if (change.kind === 'created') {
          await this.trips.createDatedTrip(timetable, change.serviceDate);
        } else if (change.kind === 'changed') {
          await this.repointTrip(change.tripId!, timetable, change.serviceDate);
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

  /**
   * Moves one dated trip onto the new version, keeping its trip id, and
   * re-announces it.
   *
   * `TripPublished` rather than a withdraw-and-recreate pair: the train still
   * runs that day, and withdrawing would tell inventory to destroy seats
   * travellers may hold. Consumers already treat `TripPublished` as an upsert
   * keyed by trip id.
   */
  private async repointTrip(
    tripId: string,
    timetable: TimetableEntity,
    serviceDate: string,
  ): Promise<void> {
    const correlationId = this.correlationId();

    await this.unitOfWork.withTransaction(async (ctx) => {
      const manager = this.repository.managerOf(ctx);
      const occurredAt = new Date();

      const timetableStops = await this.trips.getTimetableStops(
        timetable.id,
        manager,
      );
      const coaches = await this.trips.getTrainCoaches(
        timetable.train.id,
        manager,
      );
      const capacity = this.trips.calculateCapacity(coaches);
      const compositionSnapshot = this.trips.buildCompositionSnapshot(coaches);
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
 * Same stations, same order, same instants. A stop whose clock reading moved
 * by a minute is a different shape -- that minute is the Sprint 5 delay, and
 * a traveller holding a seat on the old time has to be told, not quietly
 * moved.
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

/** The new version as it was submitted; its rows are already written. */
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
