import type { CallOptions } from '@grpc/grpc-js';
import type { Observable } from 'rxjs';
import type { CivilDateTime } from '@app/contracts';

/** The operations rpcs as this gateway calls them; these match `catalog.proto`. */

export interface PublishTimetableGrpcStop {
  stationId: string;
  position: number;
  dayOffset: number;
  /** Absent on the wire at the first stop -- proto3 has no `null`. */
  arrivalTime?: string;
  /** Absent on the wire at the last stop. */
  departureTime?: string;
}

export interface PublishTimetableGrpcCoach {
  position: number;
  coachNumber: number;
  travelClassId: string;
  coachLayoutId: string;
}

export interface PublishTimetableGrpcFare {
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
}

export interface PublishTimetableGrpcRequest {
  trainNumber: string;
  runningDays: number[];
  effectiveFrom: string;
  stops: PublishTimetableGrpcStop[];
  coaches: PublishTimetableGrpcCoach[];
  fares: PublishTimetableGrpcFare[];
}

/** The counts are optional so a genuine `0` is not an absent key. */
export interface PublishTimetableGrpcResponse {
  timetableId: string;
  version: number;
  created?: number;
  changed?: number;
  withdrawn?: number;
}

export interface ChangeFareGrpcRequest {
  trainNumber: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
  /** ISO instant. */
  effectiveFrom: string;
}

export interface ChangeFareGrpcResponse {
  fareId: string;
  /** Absent exactly on the pair's first-ever fare. */
  previousAmountPiastres?: number;
  newAmountPiastres: number;
  effectiveFrom: string;
}

export interface ListAuditEntriesGrpcRequest {
  trainId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

export interface AuditEntryGrpc {
  id: string;
  action: string;
  actorAccountId: string;
  trainId: string;
  beforeJson: string;
  afterJson: string;
  /** Always 0 this sprint; optional so zero is not confused with absent. */
  ticketsAffected?: number;
  correlationId: string;
  occurredAt: CivilDateTime;
}

export interface ListAuditEntriesGrpcResponse {
  entries: AuditEntryGrpc[];
  nextCursor?: string;
}

/** `metadata`/`options` are declared on every method so a deadline can be threaded through. */
export interface OperationsGrpcClient {
  publishTimetable(
    data: PublishTimetableGrpcRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<PublishTimetableGrpcResponse>;

  changeFare(
    data: ChangeFareGrpcRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<ChangeFareGrpcResponse>;

  listAuditEntries(
    data: ListAuditEntriesGrpcRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<ListAuditEntriesGrpcResponse>;
}

/** The resolved service proxy. */
export const OPERATIONS_GRPC_CLIENT = Symbol('OPERATIONS_GRPC_CLIENT');
