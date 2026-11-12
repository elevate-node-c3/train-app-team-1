import { Injectable } from '@nestjs/common';
import type { CivilDateTime } from '@app/contracts';

import type { ChangeFareDto } from './dto/change-fare.dto.js';
import type { ListAuditQueryDto } from './dto/list-audit.dto.js';
import type { PublishTimetableDto } from './dto/publish-timetable.dto.js';
import { OperationsGrpcClientService } from './operations.grpc.client.js';

/** Used only when a caller sends no `limit` at all, matching catalog's own default. */
const DEFAULT_AUDIT_LIST_LIMIT = 50;

/**
 * What the publish answers with. `created`/`changed`/`withdrawn` are present
 * only when catalog's response carries them -- `optional` on the wire so a
 * genuine `0` (a republish that only re-points) is never confused with
 * "field never set" (TA-20, Task 10 §5).
 */
export interface PublishTimetableResult {
  timetableId: string;
  version: number;
  created?: number;
  changed?: number;
  withdrawn?: number;
}

export interface ChangeFareResult {
  fareId: string;
  /** Absent exactly on the pair's first-ever fare. */
  previousAmountPiastres?: number;
  newAmountPiastres: number;
  effectiveFrom: string;
}

export interface AuditEntryResult {
  id: string;
  action: string;
  actorAccountId: string;
  trainId: string;
  /** Decoded from catalog's `beforeJson`, a snapshot rather than a typed shape. */
  before: unknown;
  after: unknown;
  ticketsAffected?: number;
  correlationId: string;
  occurredAt: CivilDateTime;
}

export interface ListAuditResult {
  entries: AuditEntryResult[];
  nextCursor?: string;
}

/**
 * Shapes the operator surface for the HTTP edge.
 *
 * Thin on purpose: no rule here decides whether a publish or a fare change is
 * valid -- that is catalog's, re-checked there regardless of what passed
 * here. The only real work is translating DTO to wire request and back,
 * preserving the zero-vs-absent distinction the wire's `optional` fields
 * carry.
 */
@Injectable()
export class OperationsService {
  constructor(private readonly operations: OperationsGrpcClientService) {}

  async publishTimetable(
    dto: PublishTimetableDto,
    idempotencyKey: string,
  ): Promise<PublishTimetableResult> {
    const response = await this.operations.publishTimetable(
      {
        trainNumber: dto.trainNumber,
        runningDays: dto.runningDays,
        effectiveFrom: dto.effectiveFrom,
        stops: dto.stops.map((stop) => ({
          stationId: stop.stationId,
          position: stop.position,
          dayOffset: stop.dayOffset,
          ...(stop.arrivalTime === undefined
            ? {}
            : { arrivalTime: stop.arrivalTime }),
          ...(stop.departureTime === undefined
            ? {}
            : { departureTime: stop.departureTime }),
        })),
        coaches: dto.coaches,
        fares: dto.fares,
      },
      idempotencyKey,
    );

    return {
      timetableId: response.timetableId,
      version: response.version,
      ...(response.created === undefined ? {} : { created: response.created }),
      ...(response.changed === undefined ? {} : { changed: response.changed }),
      ...(response.withdrawn === undefined
        ? {}
        : { withdrawn: response.withdrawn }),
    };
  }

  async changeFare(
    dto: ChangeFareDto,
    idempotencyKey: string,
  ): Promise<ChangeFareResult> {
    const response = await this.operations.changeFare(
      {
        trainNumber: dto.trainNumber,
        travelClassId: dto.travelClassId,
        originStationId: dto.originStationId,
        destinationStationId: dto.destinationStationId,
        amountPiastres: dto.amountPiastres,
        effectiveFrom: dto.effectiveFrom,
      },
      idempotencyKey,
    );

    return {
      fareId: response.fareId,
      ...(response.previousAmountPiastres === undefined
        ? {}
        : { previousAmountPiastres: response.previousAmountPiastres }),
      newAmountPiastres: response.newAmountPiastres,
      effectiveFrom: response.effectiveFrom,
    };
  }

  /**
   * BR-52's trail. `before`/`after` arrive as JSON strings on the wire
   * (catalog never rewrites a snapshot's shape), parsed here so the REST
   * response carries nested JSON rather than a string a client must parse
   * itself again.
   */
  async listAudit(query: ListAuditQueryDto): Promise<ListAuditResult> {
    const response = await this.operations.listAuditEntries({
      ...(query.trainId === undefined ? {} : { trainId: query.trainId }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      limit: query.limit ?? DEFAULT_AUDIT_LIST_LIMIT,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });

    return {
      // proto3 omits an empty repeated field entirely, so a page with no
      // rows arrives with no `entries` key at all.
      entries: (response.entries ?? []).map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorAccountId: entry.actorAccountId,
        trainId: entry.trainId,
        before: JSON.parse(entry.beforeJson),
        after: JSON.parse(entry.afterJson),
        ...(entry.ticketsAffected === undefined
          ? {}
          : { ticketsAffected: entry.ticketsAffected }),
        correlationId: entry.correlationId,
        occurredAt: entry.occurredAt,
      })),
      ...(response.nextCursor === undefined
        ? {}
        : { nextCursor: response.nextCursor }),
    };
  }
}
