import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';

import {
  cairoCivilDateOf,
  ErrorCode,
  type FareChangedPayloadV1,
  type ValidationIssueRef,
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

/** One fare for one train, class, and station pair. */
export interface ChangeFareRequest {
  trainNumber: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
  /** ISO instant; now or later, never strictly past. */
  effectiveFrom: string;
}

export interface ChangeFareResult {
  fareId: string;
  /** Null when this is the first fare ever recorded for this (class, pair). */
  previousAmountPiastres: number | null;
  newAmountPiastres: number;
  effectiveFrom: string;
}

/** A reused `Idempotency-Key` or fare tuple both raise this SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/** `fare`'s unique key: (train, class, origin, destination, effective_from). */
const FARE_UNIQUE_CONSTRAINT = 'uq_fare_effective_version';

/** Both `code` and `driverError.code`, because TypeORM wraps the driver's error. */
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

/** Constraint names distinguish idempotency-key and fare-tuple violations (both 23505). */
function constraintNameOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as {
    constraint?: unknown;
    driverError?: { constraint?: unknown };
  };

  if (typeof candidate.constraint === 'string') return candidate.constraint;
  if (typeof candidate.driverError?.constraint === 'string') {
    return candidate.driverError.constraint;
  }
  return undefined;
}

/**
 * Append fare versions for future sales; never rewrite past prices.
 * No inventory call is needed because fare changes do not alter trips.
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
      const replay = await this.replayRace(
        error,
        request,
        idempotencyKey,
        fingerprint,
      );
      if (replay) return replay;
      throw error;
    }
  }

  private refusal(
    code: ErrorCode,
    details: ValidationIssueRef[],
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

  /** A matching fingerprint replays; a different one is refused. */
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
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REUSED',
          actionKey: 'ACTION_SEND_NEW_IDEMPOTENCY_KEY',
        },
      ]);
    }

    return JSON.parse(stored.responseJson) as ChangeFareResult;
  }

  /** Every problem in one answer, so an operator hears all refusals at once. */
  private async validate(
    request: ChangeFareRequest,
    references: FareChangeReferences,
  ): Promise<ValidationIssueRef[]> {
    const details: ValidationIssueRef[] = [];

    const amountValid =
      Number.isSafeInteger(request.amountPiastres) &&
      request.amountPiastres > 0;

    if (!amountValid) {
      details.push({
        field: 'amountPiastres',
        rejectedValue: request.amountPiastres,
        issueKey: 'ISSUE_FARE_NOT_POSITIVE_PIASTRES',
        actionKey: 'ACTION_SEND_POSITIVE_PIASTRES',
      });
    } else if (!isChargeableFare(request.amountPiastres)) {
      // Fees are positive, so fare >= floor implies fare + fee >= floor.
      details.push({
        field: 'amountPiastres',
        rejectedValue: request.amountPiastres,
        issueKey: 'ISSUE_FARE_BELOW_PAYMENT_MINIMUM',
        actionKey: 'ACTION_RAISE_FARE_TO_PAYMENT_MINIMUM',
      });
    }

    const effectiveInstant = new Date(request.effectiveFrom);
    const effectiveFromValid = !Number.isNaN(effectiveInstant.getTime());

    if (!effectiveFromValid) {
      details.push({
        field: 'effectiveFrom',
        rejectedValue: request.effectiveFrom,
        issueKey: 'ISSUE_NOT_AN_INSTANT',
        actionKey: 'ACTION_SEND_ISO_INSTANT',
      });
    } else if (effectiveInstant.getTime() < Date.now()) {
      // Accept now; refuse only strictly past instants.
      details.push({
        field: 'effectiveFrom',
        rejectedValue: request.effectiveFrom,
        issueKey: 'ISSUE_INSTANT_IN_THE_PAST',
        actionKey: 'ACTION_PICK_INSTANT_NOW_OR_LATER',
      });
    }

    if (!references.train) {
      details.push({
        field: 'trainNumber',
        rejectedValue: request.trainNumber,
        issueKey: 'ISSUE_TRAIN_NUMBER_NOT_KNOWN',
        actionKey: 'ACTION_PICK_TRAIN_FROM_LIST',
      });
    }

    if (!references.travelClass) {
      details.push({
        field: 'travelClassId',
        rejectedValue: request.travelClassId,
        issueKey: 'ISSUE_TRAVEL_CLASS_NOT_KNOWN',
        actionKey: 'ACTION_PICK_TRAVEL_CLASS_FROM_LIST',
      });
    }

    if (!references.knownStationIds.has(request.originStationId)) {
      details.push({
        field: 'originStationId',
        rejectedValue: request.originStationId,
        issueKey: 'ISSUE_STATION_NOT_KNOWN',
        actionKey: 'ACTION_PICK_STATION_FROM_LIST',
      });
    }

    if (!references.knownStationIds.has(request.destinationStationId)) {
      details.push({
        field: 'destinationStationId',
        rejectedValue: request.destinationStationId,
        issueKey: 'ISSUE_STATION_NOT_KNOWN',
        actionKey: 'ACTION_PICK_STATION_FROM_LIST',
      });
    }

    // Order and containment need every reference resolved and a real amount.
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
   * Require the pair in travel order and an amount that respects fare containment.
   * Check the route effective on the fare's civil date, not today's.
   */
  private async validateOrderAndContainment(
    request: ChangeFareRequest,
    trainId: string,
    effectiveInstant: Date,
  ): Promise<ValidationIssueRef[]> {
    const details: ValidationIssueRef[] = [];
    const order = await this.repository.routeStationOrder(
      trainId,
      cairoCivilDateOf(effectiveInstant),
    );

    if (!order) {
      details.push({
        field: 'originStationId',
        rejectedValue: request.originStationId,
        issueKey: 'ISSUE_TRAIN_HAS_NO_PUBLISHED_ROUTE',
        actionKey: 'ACTION_PUBLISH_TIMETABLE_FIRST',
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
        issueKey: 'ISSUE_TRAIN_DOES_NOT_RUN_PAIR_IN_ORDER',
        actionKey: 'ACTION_PICK_PAIR_IN_TRAVEL_ORDER',
      });
      return details;
    }

    // One stop shorter at either end is enough for containment.
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
          issueKey: 'ISSUE_FARE_BELOW_CONTAINED_SEGMENT',
          actionKey: 'ACTION_RAISE_FARE_TO_CONTAINED_SEGMENT',
          params: { containedFarePiastres: String(inner) },
        });
      }
    }

    return details;
  }

  /** Lock, fare row, audit, event and key commit together or not at all. */
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
      // Lock before reading the prior amount so concurrent writers cannot interleave.
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
        // No ticket tables yet; fare changes do not write trips.
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
   * Same-key and same-fare-tuple races both raise 23505.
   * Inspect the constraint name to choose replay or refusal.
   */
  private async replayRace(
    error: unknown,
    request: ChangeFareRequest,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<ChangeFareResult | null> {
    if (!hasPostgresCode(error, UNIQUE_VIOLATION)) return null;

    if (constraintNameOf(error) === FARE_UNIQUE_CONSTRAINT) {
      throw this.refusal(ErrorCode.CONFLICT, [
        {
          field: 'effectiveFrom',
          rejectedValue: request.effectiveFrom,
          issueKey: 'ISSUE_FARE_ALREADY_EFFECTIVE_AT_INSTANT',
          actionKey: 'ACTION_PICK_DIFFERENT_EFFECTIVE_INSTANT',
        },
      ]);
    }

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

    return JSON.parse(stored.responseJson) as ChangeFareResult;
  }
}
