import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';

import {
  cairoToday,
  ErrorCode,
  type FareChangedPayloadV1,
  type ValidationErrorDetail,
} from '@app/contracts';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging';

import { isChargeableFare } from '../../config/operations-settings.js';
import { CatalogSearchError } from '../trips/catalog-search-error.js';

import { FareChangeRepository } from './fare-change.repository.js';
import type { FareChangeReferences } from './fare-change.types.js';
import { buildFareChanged } from './fare-events.factory.js';
import { OperationsAuditService } from './operations-audit.service.js';
import {
  fingerprintOf,
  OperationsRequestRepository,
} from './operations-request.repository.js';

/** The ENR operator's input (TA-20): one fare, for one train, class and pair. */
export interface ChangeFareRequest {
  trainNumber: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
  /** ISO instant. "Now or later" is accepted; a strictly past instant is not (BR-51). */
  effectiveFrom: string;
}

export interface ChangeFareResult {
  fareId: string;
  /** Null when this is the first fare ever recorded for this (class, pair). */
  previousAmountPiastres: number | null;
  newAmountPiastres: number;
  effectiveFrom: string;
}

/** A unique violation -- here, a reused `Idempotency-Key`. */
const UNIQUE_VIOLATION = '23505';

/**
 * Both `code` and `driverError.code`, because TypeORM wraps the driver's
 * error. Same shape as `timetable-publish.service.ts`'s `hasPostgresCode`.
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

/**
 * Changing one fare, for future sales only (TA-20, BR-30).
 *
 * The previous fare row is never rewritten: a hold already made keeps the
 * price it was shown, and a search before the new `effectiveFrom` still
 * resolves the old amount. Only a new row is added -- the publish flow's own
 * governing rule, read for one fare instead of a whole timetable: change the
 * future, never the past.
 *
 * No seam call. A fare change writes no trip and alters no trip's times or
 * stops, so BR-50 (the seat-usage question `TimetablePublishService` must
 * ask) is not in play here.
 */
@Injectable()
export class FareChangeService {
  private readonly logger = new Logger(FareChangeService.name);

  constructor(
    private readonly repository: FareChangeRepository,
    private readonly audit: OperationsAuditService,
    private readonly requests: OperationsRequestRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    private readonly cls: ClsService,
  ) {}

  async changeFare(
    request: ChangeFareRequest,
    idempotencyKey: string,
    actorAccountId: string,
  ): Promise<ChangeFareResult> {
    const fingerprint = fingerprintOf(request);

    // A genuine retry gets the first answer back; a reused key on different
    // content is a client bug, not a replay.
    const replayed = await this.replay(idempotencyKey, fingerprint);
    if (replayed) return replayed;

    const trainNumber = Number(request.trainNumber);
    const references = await this.repository.resolveReferences({
      trainNumber: Number.isSafeInteger(trainNumber) ? trainNumber : null,
      travelClassId: request.travelClassId,
      stationIds: [request.originStationId, request.destinationStationId],
    });

    const details = await this.validate(request, references);
    if (details.length > 0) {
      throw this.refusal(ErrorCode.VALIDATION_ERROR, details);
    }

    try {
      return await this.commit({
        request,
        trainId: references.train!.id,
        idempotencyKey,
        fingerprint,
        actorAccountId,
      });
    } catch (error: unknown) {
      const replay = await this.replayRace(error, idempotencyKey, fingerprint);
      if (replay) return replay;
      throw error;
    }
  }

  private refusal(
    code: ErrorCode,
    details: ValidationErrorDetail[],
  ): CatalogSearchError {
    return new CatalogSearchError(code, details, code);
  }

  /** The ambient trace, so a fare change and its event share one id. */
  private correlationId(): string {
    const ambient = this.cls.isActive()
      ? this.cls.get<string>(CORRELATION_ID_KEY)
      : null;

    return ambient || randomUUID();
  }

  /**
   * A stored key with a matching fingerprint replays; a stored key with a
   * different fingerprint is refused -- silently applying it would be worse
   * than either answer.
   */
  private async replay(
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<ChangeFareResult | null> {
    const stored = await this.requests.find(idempotencyKey);
    if (!stored) return null;

    if (stored.fingerprint !== fingerprint) {
      throw this.refusal(ErrorCode.CONFLICT, [
        {
          field: 'Idempotency-Key',
          rejectedValue: idempotencyKey,
          issue: 'has already been used for a different fare change',
          action: 'Send a new Idempotency-Key for a different request body',
        },
      ]);
    }

    return JSON.parse(stored.responseJson) as ChangeFareResult;
  }

  /**
   * Every problem in one answer -- an operator refused on the amount should
   * still hear about an unknown station in the same response.
   */
  private async validate(
    request: ChangeFareRequest,
    references: FareChangeReferences,
  ): Promise<ValidationErrorDetail[]> {
    const details: ValidationErrorDetail[] = [];

    const amountValid =
      Number.isSafeInteger(request.amountPiastres) &&
      request.amountPiastres > 0;

    if (!amountValid) {
      details.push({
        field: 'amountPiastres',
        rejectedValue: request.amountPiastres,
        issue: 'must be a positive integer number of piastres',
        action: 'Send a positive whole number of piastres',
      });
    } else if (!isChargeableFare(request.amountPiastres)) {
      // No fee term: the fee is strictly positive, so `fare >= floor` already
      // implies `fare + fee >= floor` (§6.3).
      details.push({
        field: 'amountPiastres',
        rejectedValue: request.amountPiastres,
        issue: 'is below the minimum chargeable amount',
        action: 'Raise this fare to at least the Stripe minimum',
      });
    }

    const effectiveInstant = new Date(request.effectiveFrom);
    const effectiveFromValid = !Number.isNaN(effectiveInstant.getTime());

    if (!effectiveFromValid) {
      details.push({
        field: 'effectiveFrom',
        rejectedValue: request.effectiveFrom,
        issue: 'is not a valid instant',
        action: 'Send effectiveFrom as an ISO-8601 instant',
      });
    } else if (effectiveInstant.getTime() < Date.now()) {
      // Now is accepted; only strictly past is refused (BR-51).
      details.push({
        field: 'effectiveFrom',
        rejectedValue: request.effectiveFrom,
        issue: 'is in the past',
        action: 'Choose an instant that is now or later',
      });
    }

    if (!references.train) {
      details.push({
        field: 'trainNumber',
        rejectedValue: request.trainNumber,
        issue: 'is not a known train number',
        action: 'Choose a train number from the train list',
      });
    }

    if (!references.travelClass) {
      details.push({
        field: 'travelClassId',
        rejectedValue: request.travelClassId,
        issue: 'is not a known travel class',
        action: 'Choose a travel class from the travel class list',
      });
    }

    if (!references.knownStationIds.has(request.originStationId)) {
      details.push({
        field: 'originStationId',
        rejectedValue: request.originStationId,
        issue: 'is not a known station',
        action: 'Choose a station from the station list',
      });
    }

    if (!references.knownStationIds.has(request.destinationStationId)) {
      details.push({
        field: 'destinationStationId',
        rejectedValue: request.destinationStationId,
        issue: 'is not a known station',
        action: 'Choose a station from the station list',
      });
    }

    // The order and segment-containment questions only make sense once every
    // reference above resolved and the amount is a real number to compare.
    if (
      references.train &&
      references.travelClass &&
      references.knownStationIds.has(request.originStationId) &&
      references.knownStationIds.has(request.destinationStationId) &&
      effectiveFromValid &&
      amountValid
    ) {
      details.push(
        ...(await this.validateOrderAndContainment(
          request,
          references.train.id,
          effectiveInstant,
        )),
      );
    }

    return details;
  }

  /**
   * CAT-2's two rules, for one fare instead of a whole timetable: the pair
   * must run in the train's real travel order, and the new amount must not
   * undercut a segment it contains. Checked against the published route
   * effective today -- the route this fare governs right now.
   */
  private async validateOrderAndContainment(
    request: ChangeFareRequest,
    trainId: string,
    effectiveInstant: Date,
  ): Promise<ValidationErrorDetail[]> {
    const details: ValidationErrorDetail[] = [];
    const order = await this.repository.routeStationOrder(
      trainId,
      cairoToday(new Date()),
    );

    if (!order) {
      details.push({
        field: 'originStationId',
        rejectedValue: request.originStationId,
        issue: 'this train has no published route to check the pair against',
        action: 'Publish a timetable for this train before changing its fares',
      });
      return details;
    }

    const originIndex = order.indexOf(request.originStationId);
    const destinationIndex = order.indexOf(request.destinationStationId);

    if (
      originIndex === -1 ||
      destinationIndex === -1 ||
      originIndex >= destinationIndex
    ) {
      details.push({
        field: 'destinationStationId',
        rejectedValue: request.destinationStationId,
        issue: 'this train does not run this pair in order',
        action:
          'Choose an origin and destination the train visits in that travel order',
      });
      return details;
    }

    // One stop shorter at either end is enough for containment, the same
    // reduction `validateFareRules` uses for a whole timetable.
    const innerSegments: [number, number][] = [];
    if (destinationIndex - 1 > originIndex) {
      innerSegments.push([originIndex, destinationIndex - 1]);
    }
    if (originIndex + 1 < destinationIndex) {
      innerSegments.push([originIndex + 1, destinationIndex]);
    }

    for (const [innerOriginIndex, innerDestinationIndex] of innerSegments) {
      const inner = await this.repository.fareAmountAsOf({
        trainId,
        travelClassId: request.travelClassId,
        originStationId: order[innerOriginIndex],
        destinationStationId: order[innerDestinationIndex],
        asOf: effectiveInstant,
      });

      if (inner !== null && request.amountPiastres < inner) {
        details.push({
          field: 'amountPiastres',
          rejectedValue: request.amountPiastres,
          issue: `is less than the fare for a segment it contains (${inner} piastres)`,
          action:
            'Raise this fare so it is not cheaper than a segment it contains',
        });
      }
    }

    return details;
  }

  /**
   * The single transaction. The lock, the new fare row, the audit entry,
   * `FareChanged` and the idempotency key commit together or not at all.
   */
  private async commit(params: {
    request: ChangeFareRequest;
    trainId: string;
    idempotencyKey: string;
    fingerprint: string;
    actorAccountId: string;
  }): Promise<ChangeFareResult> {
    const { request, trainId } = params;
    const correlationId = this.correlationId();
    const effectiveInstant = new Date(request.effectiveFrom);

    return this.unitOfWork.withTransaction(async (ctx) => {
      // The lock first: it is what makes two same-second operators serialise
      // rather than interleave. The "previous amount" the operator is told
      // must be read only once this is held, or two concurrent changes could
      // both read the same stale previous value.
      const history = await this.repository.lockFareHistory(ctx, {
        trainId,
        travelClassId: request.travelClassId,
        originStationId: request.originStationId,
        destinationStationId: request.destinationStationId,
      });

      const previous = history.find(
        (row) => row.effectiveFrom.getTime() <= effectiveInstant.getTime(),
      );

      const fare = await this.repository.insertFare(ctx, {
        trainId,
        travelClassId: request.travelClassId,
        originStationId: request.originStationId,
        destinationStationId: request.destinationStationId,
        amountPiastres: request.amountPiastres,
        effectiveFrom: effectiveInstant,
      });

      const response: ChangeFareResult = {
        fareId: fare.id,
        previousAmountPiastres: previous?.amountPiastres ?? null,
        newAmountPiastres: request.amountPiastres,
        effectiveFrom: request.effectiveFrom,
      };

      await this.audit.append(ctx, {
        action: 'fare.changed',
        actorAccountId: params.actorAccountId,
        trainId,
        before: previous
          ? {
              amountPiastres: previous.amountPiastres,
              effectiveFrom: previous.effectiveFrom.toISOString(),
            }
          : null,
        after: {
          amountPiastres: request.amountPiastres,
          effectiveFrom: request.effectiveFrom,
        },
        // 0 this sprint, matching the publish flow: inventory has no ticket
        // tables yet, and a fare change refuses nothing on seats in use --
        // it writes no trip at all.
        ticketsAffected: 0,
        correlationId,
      });

      const payload: FareChangedPayloadV1 = {
        originStationId: request.originStationId,
        destinationStationId: request.destinationStationId,
        travelClassId: request.travelClassId,
        trainId,
        newAmountPiastres: request.amountPiastres,
        effectiveFrom: request.effectiveFrom,
      };

      await this.outbox.append(
        ctx,
        buildFareChanged({
          eventId: randomUUID(),
          correlationId,
          occurredAt: new Date(),
          payload,
        }),
      );

      await this.requests.record(ctx, {
        idempotencyKey: params.idempotencyKey,
        fingerprint: params.fingerprint,
        responseJson: JSON.stringify(response),
      });

      return response;
    });
  }

  /**
   * `record` inserts rather than saves, so a concurrent fare change that
   * committed the same key first fails this transaction instead of
   * overwriting its answer. Re-reading the key is what tells that race apart
   * from any other unique violation, which is rethrown untouched.
   */
  private async replayRace(
    error: unknown,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<ChangeFareResult | null> {
    if (!hasPostgresCode(error, UNIQUE_VIOLATION)) return null;

    const stored = await this.requests.find(idempotencyKey);
    if (!stored) return null;

    if (stored.fingerprint !== fingerprint) {
      throw this.refusal(ErrorCode.CONFLICT, [
        {
          field: 'Idempotency-Key',
          rejectedValue: idempotencyKey,
          issue: 'has already been used for a different fare change',
          action: 'Send a new Idempotency-Key for a different request body',
        },
      ]);
    }

    return JSON.parse(stored.responseJson) as ChangeFareResult;
  }
}
