import { Controller, Logger, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { CALLER_ACCOUNT_ID_KEY, GrpcCorrelationInterceptor } from '@app/common';
import { ClsService } from 'nestjs-cls';
import {
  CATALOG_SERVICE_NAME,
  civilDateTimeOf,
  ErrorCode,
  type CivilDateTime,
  type PublishTimetableRequest,
  type ValidationIssueRef,
} from '@app/contracts';

import { toRpcException } from '../trips/to-rpc-exception.js';
import { CatalogSearchError } from '../trips/catalog-search-error.js';
import type {
  ChangeFareRequest,
  ChangeFareResult,
} from './fare-change.service.js';
import { FareChangeService } from './fare-change.service.js';
import type { OperationsAuditEntity } from './entities/operations-audit.entity.js';
import type { OperationsAuditFilter } from './operations-audit.types.js';
import { OperationsAuditService } from './operations-audit.service.js';
import { TimetablePublishService } from './timetable-publish.service.js';

/** The header the operator's `Idempotency-Key` travels as, lower-cased by grpc-js. */
const IDEMPOTENCY_KEY_METADATA_KEY = 'idempotency-key';

/** Used only when a caller sends no `limit` at all, or a non-positive one. */
const DEFAULT_AUDIT_LIST_LIMIT = 50;

export interface PublishTimetableRpcStop {
  stationId: string;
  position: number;
  dayOffset: number;
  /** Absent on the wire at the first stop -- proto has no `null`. */
  arrivalTime?: string;
  /** Absent on the wire at the last stop. */
  departureTime?: string;
}

export interface PublishTimetableRpcCoach {
  position: number;
  coachNumber: number;
  travelClassId: string;
  coachLayoutId: string;
}

export interface PublishTimetableRpcFare {
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
}

/** Everything `catalog.proto`'s `PublishTimetableRequest` carries on the wire. */
export interface PublishTimetableRpcRequest {
  trainNumber: string;
  runningDays: number[];
  effectiveFrom: string;
  stops: PublishTimetableRpcStop[];
  coaches: PublishTimetableRpcCoach[];
  fares: PublishTimetableRpcFare[];
}

export interface PublishTimetableRpcResponse {
  timetableId: string;
  version: number;
  created?: number;
  changed?: number;
  withdrawn?: number;
}

export interface ChangeFareRpcResponse {
  fareId: string;
  previousAmountPiastres?: number;
  newAmountPiastres: number;
  effectiveFrom: string;
}

export interface ListAuditEntriesRpcRequest {
  trainId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditEntryRpc {
  id: string;
  action: string;
  actorAccountId: string;
  trainId: string;
  beforeJson: string;
  afterJson: string;
  ticketsAffected?: number;
  correlationId: string;
  occurredAt: CivilDateTime;
}

export interface ListAuditEntriesRpcResponse {
  entries: AuditEntryRpc[];
  nextCursor?: string;
}

function firstMetadataValue(
  metadata: Metadata | undefined,
  key: string,
): string | undefined {
  if (!metadata || typeof metadata.get !== 'function') return undefined;
  const values = metadata.get(key);
  return values.length > 0 && typeof values[0] === 'string'
    ? values[0]
    : undefined;
}

/** proto's `optional string` arrives absent as `undefined`, never `null`. */
function toPublishRequest(
  request: PublishTimetableRpcRequest,
): PublishTimetableRequest {
  return {
    trainNumber: request.trainNumber,
    runningDays: request.runningDays,
    effectiveFrom: request.effectiveFrom,
    stops: request.stops.map((stop) => ({
      stationId: stop.stationId,
      position: stop.position,
      dayOffset: stop.dayOffset,
      arrivalTime: stop.arrivalTime ?? null,
      departureTime: stop.departureTime ?? null,
    })),
    coaches: request.coaches,
    fares: request.fares,
  };
}

function toAuditEntryRpc(entry: OperationsAuditEntity): AuditEntryRpc {
  return {
    id: entry.id,
    action: entry.action,
    actorAccountId: entry.actorAccountId,
    trainId: entry.trainId,
    beforeJson: JSON.stringify(entry.before),
    afterJson: JSON.stringify(entry.after),
    ticketsAffected: entry.ticketsAffected,
    correlationId: entry.correlationId,
    occurredAt: civilDateTimeOf(entry.occurredAt),
  };
}

/**
 * The operator's side of the catalogue (TA-20): publishing a timetable
 * version, changing a fare, and reading the BR-52 trail both write.
 *
 * Unlike `TripsGrpcController`'s search, a write here is refused outright
 * when the caller or the `Idempotency-Key` is missing -- BR-52 requires
 * every change to be attributable, and "safe to retry" is a rule, not a
 * client option. Search still answers an unidentified caller because its
 * results are identical for everyone; nothing here is.
 */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class OperationsGrpcController {
  private readonly logger = new Logger(OperationsGrpcController.name);

  constructor(
    private readonly publish: TimetablePublishService,
    private readonly fareChange: FareChangeService,
    private readonly audit: OperationsAuditService,
    private readonly cls: ClsService,
  ) {}

  @GrpcMethod(CATALOG_SERVICE_NAME, 'PublishTimetable')
  async publishTimetable(
    request: PublishTimetableRpcRequest,
    metadata?: Metadata,
  ): Promise<PublishTimetableRpcResponse> {
    try {
      const { actorAccountId, idempotencyKey } = this.requireActor(metadata);

      return await this.publish.publish(
        toPublishRequest(request),
        idempotencyKey,
        actorAccountId,
      );
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(CATALOG_SERVICE_NAME, 'ChangeFare')
  async changeFare(
    request: ChangeFareRequest,
    metadata?: Metadata,
  ): Promise<ChangeFareRpcResponse> {
    try {
      const { actorAccountId, idempotencyKey } = this.requireActor(metadata);

      const result: ChangeFareResult = await this.fareChange.changeFare(
        request,
        idempotencyKey,
        actorAccountId,
      );
      return {
        ...result,
        previousAmountPiastres: result.previousAmountPiastres ?? undefined,
      };
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  /**
   * A read, not a change -- BR-52's "no change without attribution" does not
   * apply to reading the trail, so unlike the two writes above this never
   * refuses an unidentified caller.
   */
  @GrpcMethod(CATALOG_SERVICE_NAME, 'ListAuditEntries')
  async listAuditEntries(
    request: ListAuditEntriesRpcRequest,
  ): Promise<ListAuditEntriesRpcResponse> {
    const filter: OperationsAuditFilter = {
      trainId: request.trainId || undefined,
      from: request.from ? new Date(request.from) : undefined,
      to: request.to ? new Date(request.to) : undefined,
      limit:
        request.limit && request.limit > 0
          ? request.limit
          : DEFAULT_AUDIT_LIST_LIMIT,
      cursor: request.cursor || undefined,
    };

    try {
      const page = await this.audit.list(filter);
      return {
        entries: page.entries.map(toAuditEntryRpc),
        nextCursor: page.nextCursor ?? undefined,
      };
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  /**
   * Catalog never verifies a JWT itself, so a missing actor here is not an
   * anonymous traveller -- it is a gateway that stopped forwarding one, and
   * BR-52 refuses to record a change nobody can be named for. The same
   * refusal covers a missing `Idempotency-Key`: whether a retry is safe is
   * the service's rule, not something a client opts out of by omitting it.
   */
  private requireActor(metadata: Metadata | undefined): {
    actorAccountId: string;
    idempotencyKey: string;
  } {
    const actorAccountId = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
    const idempotencyKey = firstMetadataValue(
      metadata,
      IDEMPOTENCY_KEY_METADATA_KEY,
    );

    const details: ValidationIssueRef[] = [];
    if (!actorAccountId) {
      this.logger.error(
        'Gateway did not forward a caller account ID for an operator change',
      );
      details.push({
        field: 'callerAccountId',
        rejectedValue: undefined,
        issueKey: 'ISSUE_CALLER_ACCOUNT_MISSING',
        actionKey: 'ACTION_SIGN_IN_AND_RETRY',
      });
    }
    if (!idempotencyKey) {
      details.push({
        field: 'Idempotency-Key',
        rejectedValue: undefined,
        issueKey: 'ISSUE_IDEMPOTENCY_KEY_REQUIRED',
        actionKey: 'ACTION_SEND_IDEMPOTENCY_KEY',
      });
    }

    if (details.length > 0) {
      // Thrown bare: the caller's own try/catch maps it through
      // `toRpcException`, same as every other refusal in this file. Wrapping
      // it here too would be a second place that knows how to do that.
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, details);
    }

    return { actorAccountId: actorAccountId!, idempotencyKey: idempotencyKey! };
  }
}
